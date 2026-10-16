// -----------------------------------------------------------------------------
// The integration: the Viera TVs it knows (typed addresses, SSDP search), the
// Gladys devices built from them, the polling of power, volume and mute, the
// commands (serialized per TV, the state read again just before power and
// mute), the PIN pairing of the encrypted models and the configuration
// screen buttons. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseHost, parseMac } from './config.js';
import { BUTTONS, DEVICE_TYPE, FEATURES, LIMITS, REMOTE_NAME, TIMINGS } from './constants.js';
import { T } from './i18n.js';
import { appOptions, buildDevice, featureKey, stateList } from './model.js';
import { FileStore, emptyData } from './store.js';
import { VieraClient } from './viera/client.js';
import { ERROR_KINDS, TvError, request as defaultRequest } from './viera/http.js';
import { KEYS, SOURCES } from './viera/keys.js';
import { DEFAULT_PORT } from './viera/soap.js';

const BUTTON_BY_FEATURE = new Map(BUTTONS.map((button) => [button.feature, button]));

export class VieraApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'viera' }),
    store = new FileStore(),
    request = defaultRequest,
    port = DEFAULT_PORT,
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.request = request;
    this.port = port;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    this.data = undefined;
    /** udn -> VieraClient */
    this.clients = new Map();
    /** udn -> last reading { on, volume?, muted? } */
    this.readings = new Map();
    /** udn -> tail of the command queue */
    this.queues = new Map();
    /** address -> last probe time */
    this.probes = new Map();
    /** udns whose application list was read in this run */
    this.appsRead = new Set();
    /** udns of the devices created in Gladys */
    this.created = new Set();
    this.pending = undefined;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.polling = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    if (!this.data) {
      this.data = await this.store.load().catch(() => emptyData());
    }
    this.config = normalizeConfig(raw);
    this.started = true;
    await this.refreshCreated();
    await this.probeAddresses(true);
    await this.publishDevices();
    await this.poll();
    this.schedule();
    await this.updateStatus();
  }

  stop() {
    this.started = false;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  schedule() {
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = this.timers.setInterval(() => this.tick(), this.config.pollInterval * 1000);
  }

  /** One timer round: the typed addresses not answering yet, then the polling. */
  tick() {
    return this.probeAddresses(false)
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.poll())
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${err.message}`));
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  /** Writes /data now (the pairing keys are not left to a timer). */
  async saveNow() {
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.store.save(this.data);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  get tvs() {
    return Object.values(this.data?.tvs ?? {});
  }

  /** The MAC a TV is woken with: the configured one, else the one the search saw. */
  wakeMac(tv) {
    return (tv.host && this.config.macs[tv.host]) || tv.mac || undefined;
  }

  enqueue(udn, task) {
    const previous = this.queues.get(udn) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      udn,
      run.catch(() => {}),
    );
    return run;
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  // --- Known TVs ---------------------------------------------------------------

  client(tv) {
    let client = this.clients.get(tv.udn);
    if (!client || client.host !== tv.host) {
      client = new VieraClient({
        host: tv.host,
        port: this.port,
        encrypted: Boolean(tv.encrypted),
        credentials: tv.appId ? { appId: tv.appId, encKey: tv.encKey } : undefined,
        request: this.request,
        timeoutMs: this.timings.httpTimeout,
      });
      this.clients.set(tv.udn, client);
    }
    return client;
  }

  async refreshCreated() {
    try {
      const devices = await this.gladys.getDevices();
      const byId = new Map(
        this.tvs.map((tv) => [this.gladys.externalIds(DEVICE_TYPE, tv.udn).device, tv.udn]),
      );
      this.created = new Set(devices.map((d) => byId.get(d.external_id)).filter(Boolean));
    } catch (err) {
      this.logger.warn(`Could not read the Gladys devices: ${err.message}`);
    }
  }

  tvOfDevice(device) {
    return this.tvs.find(
      (tv) => this.gladys.externalIds(DEVICE_TYPE, tv.udn).device === device?.external_id,
    );
  }

  /**
   * Asks the TV at `host` who it is (UPnP description, encrypted model or
   * not) and remembers it by UDN. Throws a TvError when it does not answer
   * or is not a Panasonic TV.
   */
  async identify(host, mac) {
    const probe = new VieraClient({
      host,
      port: this.port,
      request: this.request,
      timeoutMs: this.timings.httpTimeout,
    });
    const description = await probe.describe();
    const encrypted = await probe.detectEncryption();
    return this.remember(description, host, encrypted, mac);
  }

  remember(description, host, encrypted, mac) {
    const tvs = this.data.tvs;
    let tv = tvs[description.udn];
    if (!tv) {
      if (Object.keys(tvs).length >= LIMITS.tvs) {
        this.warnOnce('tvs', `More than ${LIMITS.tvs} TVs: the next ones are ignored`);
        return undefined;
      }
      tv = { udn: description.udn };
      tvs[description.udn] = tv;
    }
    // Another TV that had this address lost it (DHCP): it is found again by
    // the search, never commanded at an address that is no longer its own.
    for (const other of this.tvs) {
      if (other.udn !== tv.udn && other.host === host) {
        this.logger.warn(`${other.name} no longer answers at ${host}: ${description.name} does`);
        other.host = '';
        this.clients.delete(other.udn);
        this.readings.set(other.udn, { on: false });
      }
    }
    if (tv.host !== host) {
      this.clients.delete(tv.udn);
    }
    Object.assign(tv, {
      host,
      name: description.name,
      model: description.model,
      encrypted: Boolean(encrypted || tv.appId),
    });
    if (mac) {
      tv.mac = mac;
    }
    this.persist();
    return tv;
  }

  /** The typed addresses: asked at start, then every minute while unknown. */
  async probeAddresses(force) {
    let changed = false;
    await Promise.all(
      this.config.addresses.map(async (host) => {
        const known = this.tvs.find((tv) => tv.host === host);
        if (known && (!force || this.readings.get(known.udn)?.on)) {
          return;
        }
        const last = this.probes.get(host) ?? -Infinity;
        if (!force && this.now() - last < this.timings.probeRetry) {
          return;
        }
        this.probes.set(host, this.now());
        try {
          const tv = await this.identify(host);
          changed = changed || Boolean(tv);
        } catch (err) {
          this.logger.debug?.(`${host}: ${err.message}`);
        }
      }),
    );
    return changed;
  }

  /** SSDP search through Gladys, then the typed addresses. */
  async scan() {
    let results = [];
    try {
      results = await this.gladys.scanNetwork('ssdp', {
        timeoutSeconds: this.timings.scanSeconds,
      });
    } catch (err) {
      this.logger.warn(`SSDP search failed: ${err.message}`);
    }
    const seen = new Set();
    for (const result of Array.isArray(results) ? results : []) {
      const host = result?.source_ip;
      if (typeof host !== 'string' || isIP(host) !== 4 || seen.has(host)) {
        continue;
      }
      seen.add(host);
      try {
        // The LOCATION header is not followed: the description is read at the
        // address that answered, on the TV port.
        await this.identify(host, parseMac(result.source_mac));
      } catch (err) {
        this.logger.debug?.(`${host} is not a Viera TV: ${err.message}`);
      }
    }
    await this.probeAddresses(true);
    await this.publishDevices();
    return this.tvs;
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    await this.gladys.publishDiscoveredDevices(this.tvs.map((tv) => buildDevice(this.gladys, tv)));
  }

  // --- Polling -------------------------------------------------------------------

  poll() {
    if (!this.polling) {
      this.polling = Promise.all(
        this.tvs
          .filter((tv) => this.created.has(tv.udn) && tv.host)
          .map((tv) => this.readState(tv)),
      ).finally(() => {
        this.polling = undefined;
      });
    }
    return this.polling;
  }

  /** Volume and mute from DMR: an answer means the TV is on. */
  async read(tv) {
    if (!tv.host) {
      return { on: false };
    }
    const client = this.client(tv);
    try {
      const muted = await client.getMute();
      const volume = await client.getVolume();
      return { on: true, muted, volume };
    } catch (err) {
      if (err.kind !== ERROR_KINDS.UNREACHABLE) {
        this.warnOnce(`read:${tv.udn}`, `${tv.name}: unexpected answer (${err.message})`);
      }
      return { on: false };
    }
  }

  async readState(tv) {
    const wasOn = this.readings.get(tv.udn)?.on;
    let reading = await this.read(tv);
    if (reading.on && !wasOn) {
      // Back online: make sure the address still belongs to this TV.
      try {
        const description = await this.client(tv).describe();
        if (description.udn !== tv.udn) {
          // Its address went to another TV (DHCP): never command it there. The
          // next search finds both again.
          this.logger.warn(`${tv.name}: another TV answers at ${tv.host}, run a search`);
          tv.host = '';
          this.clients.delete(tv.udn);
          this.persist();
          reading = { on: false };
        }
      } catch {
        reading = { on: false };
      }
    }
    this.readings.set(tv.udn, reading);
    if (
      reading.on &&
      !this.appsRead.has(tv.udn) &&
      (!tv.encrypted || (tv.appId && !tv.keysRefused))
    ) {
      this.appsRead.add(tv.udn);
      this.enqueue(tv.udn, () => this.readApps(tv)).catch(() => {});
    }
    await this.publishStates(tv, reading);
    return reading;
  }

  async publishStates(tv, reading) {
    if (!this.created.has(tv.udn)) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(stateList(this.gladys, tv, reading));
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${tv.name}: ${err.message}`);
    }
  }

  /** The TV's own application list, added to the dropdown at the next update. */
  async readApps(tv) {
    try {
      const apps = (await this.client(tv).getApps()).slice(0, LIMITS.apps);
      if (apps.length > 0 && JSON.stringify(apps) !== JSON.stringify(tv.apps ?? [])) {
        tv.apps = apps;
        this.persist();
        await this.publishDevices();
      }
    } catch (err) {
      this.handleCommandError(tv, err);
      this.logger.debug?.(`${tv.name}: no application list (${err.message})`);
    }
  }

  // --- Commands --------------------------------------------------------------------

  async setValue(device, feature, value) {
    const tv = this.tvOfDevice(device);
    if (!tv) {
      throw new Error(`Unknown TV ${device?.external_id}`);
    }
    const key = featureKey(device.external_id, feature?.external_id);
    return this.enqueue(tv.udn, async () => {
      try {
        await this.command(tv, key, value);
      } catch (err) {
        this.handleCommandError(tv, err);
        throw err;
      }
    });
  }

  handleCommandError(tv, err) {
    if (err.kind === ERROR_KINDS.KEYS_REFUSED && !tv.keysRefused) {
      tv.keysRefused = true;
      this.persist();
      this.logger.warn(`${tv.name} refused its pairing keys: pair it again`);
      this.updateStatus().catch(() => {});
    }
  }

  async command(tv, key, value) {
    if (!tv.host) {
      throw new TvError(ERROR_KINDS.UNREACHABLE, `${tv.name}: address unknown, run a search`);
    }
    const client = this.client(tv);
    const needsKeys = key !== FEATURES.VOLUME && key !== FEATURES.MUTE && key !== FEATURES.POWER;
    if (needsKeys && tv.keysRefused) {
      throw new TvError(ERROR_KINDS.KEYS_REFUSED, `${tv.name} must be paired again`);
    }
    if (key === FEATURES.POWER) {
      return Number(value) === 1 ? this.turnOn(tv) : this.turnOff(tv);
    }
    if (key === FEATURES.VOLUME) {
      const volume = Math.round(Number(value));
      await client.setVolume(volume);
      return this.readState(tv);
    }
    if (key === FEATURES.MUTE) {
      // Gladys sends a press, not a target: toggle what the TV says right now.
      const muted = await client.getMute();
      await client.setMute(!muted);
      return this.readState(tv);
    }
    if (key === FEATURES.SOURCE) {
      const source = SOURCES.find((s) => s.value === value);
      if (!source) {
        throw new Error(`Unknown source "${String(value).slice(0, 32)}"`);
      }
      return client.sendKey(source.key);
    }
    if (key === FEATURES.APP) {
      const id = String(value ?? '').toUpperCase();
      if (!appOptions(tv).some((option) => option.value === id)) {
        throw new Error(`Unknown application "${id.slice(0, 32)}"`);
      }
      return client.launchApp(id);
    }
    if (key === FEATURES.KEY) {
      if (!Object.hasOwn(KEYS, value)) {
        throw new Error(`Unknown key "${String(value).slice(0, 32)}"`);
      }
      return client.sendKey(value);
    }
    const button = BUTTON_BY_FEATURE.get(key);
    if (!button) {
      throw new Error(`Unknown feature "${String(key).slice(0, 32)}"`);
    }
    return client.sendKey(button.key);
  }

  /**
   * The power key is a toggle: the state is read from the TV just before, and
   * nothing is sent when it already is in the wanted state.
   */
  async turnOn(tv) {
    const reading = await this.readState(tv);
    if (reading.on) {
      return reading;
    }
    const mac = this.wakeMac(tv);
    if (mac) {
      await this.gladys.wakeOnLan(mac);
      const deadline = this.now() + this.timings.wakeWait;
      while (this.now() < deadline) {
        await this.sleep(this.timings.wakeStep);
        const after = await this.readState(tv);
        if (after.on) {
          return after;
        }
      }
      // No power key after a Wake-on-LAN: a TV still booting would be turned off.
      throw new Error(
        `${tv.name} did not answer within ${this.timings.wakeWait / 1000} s of the Wake-on-LAN packet`,
      );
    }
    try {
      await this.client(tv).sendKey('power');
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        throw new TvError(
          ERROR_KINDS.UNREACHABLE,
          `${tv.name} does not answer: from deep standby it needs Wake-on-LAN (MAC address in the configuration) or the TV setting "Powered On by Apps"`,
        );
      }
      throw err;
    }
    this.recheck(tv);
    return undefined;
  }

  async turnOff(tv) {
    const reading = await this.readState(tv);
    if (!reading.on) {
      return reading;
    }
    await this.client(tv).sendKey('power');
    this.recheck(tv);
    return undefined;
  }

  recheck(tv) {
    this.timers.setTimeout(() => {
      this.readState(tv).catch(() => {});
    }, this.timings.recheckDelay);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(device) {
    const tv = this.tvOfDevice(device);
    if (!tv) {
      return;
    }
    this.created.add(tv.udn);
    this.readings.delete(tv.udn);
    await this.readState(tv);
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    const tv = this.tvOfDevice(device);
    if (tv) {
      this.created.delete(tv.udn);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons -------------------------------------------------

  async findTvs() {
    const tvs = await this.scan();
    await this.updateStatus();
    return T.found(tvs.map((tv) => `${tv.name} (${tv.host || '?'})`));
  }

  async startPairing(fields = {}) {
    const host = parseHost(fields.address);
    if (!host) {
      return T.invalidAddress;
    }
    let tv;
    try {
      tv = await this.identify(host);
    } catch (err) {
      return err.kind === ERROR_KINDS.UNREACHABLE ? T.unreachable(host) : T.notPanasonic(host);
    }
    if (!tv) {
      return T.notPanasonic(host);
    }
    if (!tv.encrypted) {
      await this.publishDevices();
      return T.noPairingNeeded(tv.name);
    }
    return this.enqueue(tv.udn, async () => {
      try {
        const challenge = await this.client(tv).requestPin(REMOTE_NAME);
        this.pending = { udn: tv.udn, challenge, expires: this.now() + this.timings.pairingTtl };
        this.logger.info(`Pairing started with ${tv.name}: PIN displayed on the TV`);
        return T.pinDisplayed(tv.name, Math.round(this.timings.pairingTtl / 60_000));
      } catch (err) {
        if (err.kind === ERROR_KINDS.UNREACHABLE) {
          return T.unreachable(host);
        }
        return T.pairingRefused(tv.name, err.description || err.message);
      }
    });
  }

  async finishPairing(fields = {}) {
    const pin = String(fields.pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pin)) {
      return T.invalidPinFormat;
    }
    const pending = this.pending;
    const tv = pending && this.data.tvs[pending.udn];
    if (!tv || this.now() > pending.expires) {
      this.pending = undefined;
      return T.noPendingPairing;
    }
    return this.enqueue(tv.udn, async () => {
      try {
        const credentials = await this.client(tv).authorizePin(pending.challenge, pin);
        this.pending = undefined;
        Object.assign(tv, { ...credentials, encrypted: true, keysRefused: false });
        await this.saveNow();
        this.logger.info(`${tv.name} paired`);
        this.appsRead.delete(tv.udn);
        await this.readApps(tv);
        this.appsRead.add(tv.udn);
        await this.publishDevices();
        await this.updateStatus();
        return T.paired(tv.name);
      } catch (err) {
        if (err.kind === ERROR_KINDS.UNREACHABLE) {
          // The PIN may still be valid: the user can try again once the TV answers.
          return T.unreachable(tv.host);
        }
        this.pending = undefined;
        if (err.kind === ERROR_KINDS.INVALID_PIN) {
          return T.wrongPin;
        }
        return T.pairingFailed(tv.name, err.description || err.message);
      }
    });
  }

  async checkTvs() {
    if (this.tvs.length === 0) {
      return T.noTv;
    }
    const lines = [];
    for (const tv of this.tvs) {
      const reading = await this.read(tv);
      lines.push(T.checkLine({ ...tv, wakeMac: this.wakeMac(tv) }, reading));
    }
    return T.check(lines);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started) {
      return;
    }
    const toPair = this.tvs
      .filter((tv) => this.created.has(tv.udn) && tv.encrypted && (!tv.appId || tv.keysRefused))
      .map((tv) => tv.name);
    let status;
    if (toPair.length > 0) {
      status = { connected: false, message: T.pairingNeeded(toPair) };
    } else if (this.config.invalid.length > 0) {
      status = { connected: true, message: T.invalidEntries(this.config.invalid) };
    } else {
      status = { connected: true };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
