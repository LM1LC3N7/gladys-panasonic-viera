// -----------------------------------------------------------------------------
// The integration: the Viera TVs it knows (typed addresses, SSDP search), the
// Gladys devices built from them, the polling of power, volume and mute, the
// commands (serialized per TV, the state read again just before power and
// mute, everything within the 5 s Gladys gives a command), the PIN pairing of
// the encrypted models and the configuration screen buttons. index.js only
// wires the SDK handlers to it.
//
// Power states are true (DMR answers), false (nothing answers) or undefined
// (the TV answers, but not as expected): an unknown state is never published
// and never decides a toggle.
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
// Features served by DMR (never encrypted): they work without pairing keys.
const DMR_FEATURES = new Set([FEATURES.VOLUME, FEATURES.MUTE, FEATURES.POWER]);

/** For the pairing messages: the TV did not answer (nothing connected, or silent). */
const isNoAnswer = (err) =>
  err?.kind === ERROR_KINDS.UNREACHABLE || err?.kind === ERROR_KINDS.TIMEOUT;

/** Runs `task` over `items`, `limit` at a time, results in order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
    /** udn -> when the application list may be asked (again) */
    this.appsNext = new Map();
    /** udn -> { count, last }: session refusals that did not refuse the keys */
    this.refusals = new Map();
    /** udn -> when refused keys may be tried again */
    this.keysRetryAt = new Map();
    /** udns of the devices created in Gladys */
    this.created = new Set();
    /** Timers of the background work (rechecks, Wake-on-LAN waits). */
    this.backgroundTimers = new Set();
    this.generation = 0;
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
    this.config = normalizeConfig(raw);
    this.started = true;
    // The timer first: whatever fails below, the next round tries again.
    this.schedule();
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/viera.json moved to viera.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('probe the addresses', () => this.probeAddresses(true));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('poll', () => this.poll());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const handle of this.backgroundTimers) {
      this.timers.clearTimeout(handle);
    }
    this.backgroundTimers.clear();
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
    if (!this.data) {
      return Promise.resolve();
    }
    return this.probeAddresses(false)
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.poll())
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${err.message}`));
  }

  /** Background work, cancelled by stop(). */
  later(task, ms) {
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(handle);
      if (generation === this.generation) {
        Promise.resolve()
          .then(task)
          .catch((err) => this.logger.debug?.(`Background task failed: ${err.message}`));
      }
    }, ms);
    this.backgroundTimers.add(handle);
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

  // --- Known TVs ---------------------------------------------------------------

  /** The client of a TV, recreated when its address, model or keys change. */
  client(tv) {
    let client = this.clients.get(tv.udn);
    if (
      !client ||
      client.host !== tv.host ||
      client.encrypted !== Boolean(tv.encrypted) ||
      client.appId !== (tv.appId || undefined)
    ) {
      client = new VieraClient({
        host: tv.host,
        port: this.port,
        encrypted: Boolean(tv.encrypted),
        credentials: tv.appId ? { appId: tv.appId, encKey: tv.encKey } : undefined,
        request: this.request,
        timeoutMs: this.timings.httpTimeout,
        onSession: () => this.sessionOpened(tv),
        now: this.now,
      });
      this.clients.set(tv.udn, client);
    }
    return client;
  }

  async refreshCreated() {
    const devices = await this.gladys.getDevices();
    const byId = new Map(
      this.tvs.map((tv) => [this.gladys.externalIds(DEVICE_TYPE, tv.udn).device, tv.udn]),
    );
    this.created = new Set(devices.map((d) => byId.get(d.external_id)).filter(Boolean));
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
        if (known && (!force || this.readings.get(known.udn)?.on === true)) {
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

  // --- Pairing keys --------------------------------------------------------------

  /** A session was opened: the keys work, whatever was counted before. */
  sessionOpened(tv) {
    this.refusals.delete(tv.udn);
    this.keysRetryAt.delete(tv.udn);
    if (tv.keysRefused) {
      tv.keysRefused = false;
      this.persist();
      this.logger.info(`${tv.name} accepts its pairing keys again`);
      this.updateStatus().catch(() => {});
    }
  }

  markKeysRefused(tv) {
    this.keysRetryAt.set(tv.udn, this.now() + this.timings.keysRetry);
    if (!tv.keysRefused) {
      tv.keysRefused = true;
      this.persist();
      this.logger.warn(`${tv.name} refused its pairing keys: pair it again`);
      this.updateStatus().catch(() => {});
    }
  }

  handleCommandError(tv, err) {
    if (err.kind === ERROR_KINDS.KEYS_REFUSED) {
      this.markKeysRefused(tv);
    } else if (err.kind === ERROR_KINDS.SESSION_REFUSED) {
      // Only a TV that is surely on can refuse anything meaningfully, and
      // only refusals spaced in time are counted.
      if (this.readings.get(tv.udn)?.on !== true) {
        return;
      }
      const record = this.refusals.get(tv.udn) ?? { count: 0, last: -Infinity };
      if (this.now() - record.last >= this.timings.refusalSpacing) {
        record.count += 1;
        record.last = this.now();
        this.refusals.set(tv.udn, record);
      }
      if (record.count >= this.timings.refusalLimit) {
        this.markKeysRefused(tv);
      }
    }
  }

  /**
   * Before an NRC request: refused keys are tried again only every
   * `keysRetry` (a slow retry, not a definitive block).
   */
  assertKeysUsable(tv) {
    if (!tv.keysRefused) {
      return;
    }
    if (this.now() < (this.keysRetryAt.get(tv.udn) ?? 0)) {
      throw new TvError(ERROR_KINDS.KEYS_REFUSED, `${tv.name} must be paired again`);
    }
    this.keysRetryAt.set(tv.udn, this.now() + this.timings.keysRetry);
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

  /**
   * Mute (then volume) from DMR: an answer means on, no answer at all means
   * off, any other answer (HTTP error, SOAP fault, unreadable) is unknown.
   */
  async read(tv, client = this.client(tv), { quick = false } = {}) {
    if (!tv.host) {
      return { on: false };
    }
    try {
      const muted = await client.getMute();
      if (quick) {
        return { on: true, muted };
      }
      const volume = await client.getVolume();
      return { on: true, muted, volume };
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        return { on: false };
      }
      if (err.kind === ERROR_KINDS.BUDGET || err.kind === ERROR_KINDS.TIMEOUT) {
        // No time left to ask, or a TV that accepted the connection and said
        // nothing: not a sign that it is off.
        return { on: undefined };
      }
      this.warnOnce(`read:${tv.udn}`, `${tv.name}: unexpected answer (${err.message})`);
      return { on: undefined };
    }
  }

  async readState(tv, options) {
    const wasOn = this.readings.get(tv.udn)?.on;
    let reading = await this.read(tv, undefined, options);
    if (reading.on === true && wasOn !== true) {
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
        reading = { on: undefined };
      }
    }
    this.readings.set(tv.udn, reading);
    if (reading.on === true) {
      this.backgroundKeysWork(tv);
    }
    await this.publishStates(tv, reading);
    return reading;
  }

  /** On a TV surely on: the application list, and the slow retry of refused keys. */
  backgroundKeysWork(tv) {
    if (tv.encrypted && !tv.appId) {
      return;
    }
    if (tv.keysRefused) {
      if (this.now() >= (this.keysRetryAt.get(tv.udn) ?? 0)) {
        this.keysRetryAt.set(tv.udn, this.now() + this.timings.keysRetry);
        this.enqueue(tv.udn, () =>
          this.client(tv)
            .withBudget(this.timings.preRead)
            .requestSession()
            .catch((err) => this.handleCommandError(tv, err)),
        ).catch(() => {});
      }
      return;
    }
    if (this.now() >= (this.appsNext.get(tv.udn) ?? 0)) {
      this.appsNext.set(tv.udn, this.now() + this.timings.appsRetry);
      this.enqueue(tv.udn, () => this.readApps(tv)).catch(() => {});
    }
  }

  async publishStates(tv, reading) {
    const states = stateList(this.gladys, tv, reading);
    if (!this.created.has(tv.udn) || states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${tv.name}: ${err.message}`);
    }
  }

  /** The TV's own application list, added to the dropdown at the next update. */
  async readApps(tv) {
    try {
      // Short: a command may be waiting behind it in the queue.
      const client = this.client(tv).withBudget(this.timings.preRead);
      const apps = (await client.getApps()).slice(0, LIMITS.apps);
      if (apps.length === 0) {
        return;
      }
      // A list was read: it is not asked again during this run.
      this.appsNext.set(tv.udn, Infinity);
      if (JSON.stringify(apps) !== JSON.stringify(tv.apps ?? [])) {
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
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    let late = false;
    const run = this.enqueue(tv.udn, async () => {
      if (late || this.remaining(started) < 50) {
        // Gladys stopped waiting while this command was queued (behind a
        // pairing...): it is dropped, never sent late.
        late = true;
        throw new TvError(ERROR_KINDS.BUDGET, 'No time left for this command');
      }
      try {
        await this.command(tv, key, value, started);
      } catch (err) {
        this.handleCommandError(tv, err);
        throw err;
      }
    });
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          reject(new TvError(ERROR_KINDS.BUDGET, 'No time left for this command (TV busy)'));
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** What is left of the budget of a command started at `started`. */
  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  async command(tv, key, value, started = this.now()) {
    if (!tv.host) {
      throw new TvError(ERROR_KINDS.UNREACHABLE, `${tv.name}: address unknown, run a search`);
    }
    if (key === FEATURES.POWER) {
      return Number(value) === 1 ? this.turnOn(tv, started) : this.turnOff(tv, started);
    }
    if (!DMR_FEATURES.has(key)) {
      this.assertKeysUsable(tv);
    }
    const client = this.client(tv).withBudget(this.remaining(started));
    if (key === FEATURES.VOLUME) {
      const volume = await client.setVolume(value);
      return this.publishStates(tv, { on: true, volume });
    }
    if (key === FEATURES.MUTE) {
      // Gladys sends a press, not a target: toggle what the TV says right now.
      const muted = await client.getMute();
      await client.setMute(!muted);
      return this.publishStates(tv, { on: true, muted: !muted });
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

  /** The state just before a power command, within `preRead` (and the budget left). */
  async quickRead(tv, started) {
    const budget = Math.min(this.timings.preRead, this.remaining(started));
    const reading = await this.read(tv, this.client(tv).withBudget(budget), { quick: true });
    if (reading.on !== undefined) {
      this.readings.set(tv.udn, reading);
      await this.publishStates(tv, reading);
    }
    return reading;
  }

  /**
   * The power key is a toggle: the state is read from the TV just before,
   * nothing is sent when it already is in the wanted state, and never on an
   * unknown state. With a MAC, Wake-on-LAN is always sent, and the command is
   * acked at once: the TV is waited for in the background.
   */
  async turnOn(tv, started = this.now()) {
    const reading = await this.quickRead(tv, started);
    if (reading.on === true) {
      return;
    }
    const budget = () => this.client(tv).withBudget(this.remaining(started));
    const mac = this.wakeMac(tv);
    if (!mac) {
      if (reading.on === undefined) {
        throw new Error(
          `${tv.name}: power state unknown, nothing sent (use the "Remote key" Power to toggle)`,
        );
      }
      this.assertKeysUsable(tv);
      try {
        await budget().sendKey('power');
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
      return;
    }
    if (reading.on === false && !tv.keysRefused && !(tv.encrypted && !tv.appId)) {
      // Network standby: port 55000 still answers, the power key wakes it.
      const scoped = budget();
      const answers = await scoped.describe().then(
        () => true,
        () => false,
      );
      if (answers) {
        await scoped.sendKey('power').catch((err) => {
          this.handleCommandError(tv, err);
          this.logger.debug?.(`${tv.name}: power key not sent (${err.message})`);
        });
      }
    }
    await this.wake(tv, mac);
    this.confirmWake(tv, mac, this.now() + this.timings.wakeWait);
  }

  async turnOff(tv, started = this.now()) {
    const reading = await this.quickRead(tv, started);
    if (reading.on === false) {
      return;
    }
    if (reading.on === undefined) {
      throw new Error(
        `${tv.name}: power state unknown, nothing sent (use the "Remote key" Power to toggle)`,
      );
    }
    this.assertKeysUsable(tv);
    await this.client(tv).withBudget(this.remaining(started)).sendKey('power');
    this.recheck(tv);
  }

  /** One magic packet through Gladys; a refusal (429...) is left to the next try. */
  async wake(tv, mac) {
    try {
      const options = this.config.wakeAddress ? { address: this.config.wakeAddress } : undefined;
      await this.gladys.wakeOnLan(mac, options);
    } catch (err) {
      this.logger.debug?.(`${tv.name}: Wake-on-LAN not sent (${err.status ?? err.message})`);
    }
  }

  /** In the background: the packet again every `wakeStep` until the TV answers. Never a power key. */
  confirmWake(tv, mac, deadline) {
    this.later(async () => {
      const reading = await this.readState(tv);
      if (reading.on === true) {
        return;
      }
      if (this.now() >= deadline) {
        this.logger.warn(`${tv.name} did not answer after Wake-on-LAN`);
        return;
      }
      await this.wake(tv, mac);
      this.confirmWake(tv, mac, deadline);
    }, this.timings.wakeStep);
  }

  recheck(tv) {
    this.later(() => this.readState(tv), this.timings.recheckDelay);
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

  async startPairing(fields) {
    if (fields?.address === undefined) {
      return T.updateGladys;
    }
    const host = parseHost(fields.address);
    if (!host) {
      return T.invalidAddress;
    }
    let tv;
    try {
      tv = await this.identify(host);
    } catch (err) {
      return isNoAnswer(err) ? T.unreachable(host) : T.notPanasonic(host);
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
        if (isNoAnswer(err)) {
          return T.unreachable(host);
        }
        return T.pairingRefused(tv.name, err.description || err.message);
      }
    });
  }

  async finishPairing(fields) {
    if (fields?.pin === undefined) {
      return T.updateGladys;
    }
    const pin = String(fields.pin).trim();
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
      let credentials;
      try {
        credentials = await this.client(tv).authorizePin(pending.challenge, pin);
      } catch (err) {
        if (isNoAnswer(err)) {
          // The PIN may still be valid: the user can try again once the TV answers.
          return T.unreachable(tv.host);
        }
        this.pending = undefined;
        if (err.kind === ERROR_KINDS.INVALID_PIN) {
          return T.wrongPin;
        }
        return T.pairingFailed(tv.name, err.description || err.message);
      }
      this.pending = undefined;
      // The keys are saved before anything else is asked of the TV.
      Object.assign(tv, { ...credentials, encrypted: true, keysRefused: false });
      this.refusals.delete(tv.udn);
      this.keysRetryAt.delete(tv.udn);
      try {
        await this.saveNow();
      } catch (err) {
        this.logger.warn(`Could not save the pairing keys: ${err.message}`);
      }
      this.logger.info(`${tv.name} paired`);
      try {
        await this.client(tv).requestSession();
        this.appsNext.delete(tv.udn);
        await this.readApps(tv);
      } catch (err) {
        this.logger.warn(`${tv.name}: no session right after pairing (${err.message})`);
      }
      await this.publishDevices();
      await this.updateStatus();
      return T.paired(tv.name);
    });
  }

  async checkTvs() {
    if (this.tvs.length === 0) {
      return T.noTv;
    }
    const lines = await mapLimit(this.tvs, this.timings.checkConcurrency, async (tv) =>
      T.checkLine({ ...tv, wakeMac: this.wakeMac(tv) }, await this.read(tv)),
    );
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
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    let status;
    if (toPair.length > 0) {
      notes.unshift(T.pairingNeeded(toPair));
      status = { connected: false };
    } else {
      status = { connected: true };
    }
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
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
