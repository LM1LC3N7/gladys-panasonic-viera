// -----------------------------------------------------------------------------
// VieraApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake TV on the loopback interface.
// The polling timer never fires: the tests drive it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { VieraApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore } from '../src/store.js';
import { OTHER_UDN, PIN, UDN, startFakeTv } from './fixtures/fakeTv.js';

const SELECTOR = 'panasonic-viera';
const id = (udn, key) => `ext:${SELECTOR}:tv:${udn}${key ? `:${key}` : ''}`;
const MAC = 'a8:13:74:12:34:56';

/** No polling interval; short real timeouts for the waits. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

async function setup(
  t,
  {
    tvOptions,
    config = { addresses: '127.0.0.1' },
    store = new MemoryStore(),
    scanResults = {},
    timings = {},
    realTimers = false,
  } = {},
) {
  const tv = await startFakeTv(tvOptions);
  t.after(() => tv.close());
  const gladys = createFakeGladys({ selector: SELECTOR, config, scanResults });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new VieraApp({
    gladys,
    logger,
    store,
    port: tv.port,
    timers: realTimers ? { ...timers, setTimeout: globalThis.setTimeout } : timers,
    timings: {
      ...TIMINGS,
      httpTimeout: 1000,
      wakeWait: 200,
      wakeStep: 10,
      recheckDelay: 1,
      ...timings,
    },
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  return { tv, gladys, app, logs, store };
}

async function createTv(gladys, udn = UDN) {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id(udn));
  assert.ok(device, 'the TV is in the Discovery tab');
  await gladys.fake.deviceCreated(device);
  return device;
}

const set = (gladys, device, key, value) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(UDN, key)),
    value,
  );

test('a typed address becomes a Gladys device; its states once created', async (t) => {
  const { gladys, store } = await setup(t);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, id(UDN));
  assert.equal(device.name, 'Living room TV (TX-55GZ950)');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const keys = device.features.map((f) => f.external_id.slice(id(UDN).length + 1));
  for (const key of ['power', 'volume', 'mute', 'source', 'app', 'key', 'volume_up', 'enter']) {
    assert.ok(keys.includes(key), key);
  }
  assert.equal(new Set(keys).size, keys.length, 'feature keys are unique');
  assert.ok(device.features.every((f) => f.min !== undefined && f.max !== undefined));
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');

  await createTv(gladys);
  assert.equal(gladys.fake.lastState(id(UDN, 'power')), 1);
  assert.equal(gladys.fake.lastState(id(UDN, 'volume')), 12);
  assert.equal(gladys.fake.lastState(id(UDN, 'mute')), 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.data.tvs[UDN].host, '127.0.0.1');
  assert.equal(store.data.tvs[UDN].encrypted, false);
});

test('commands of a model without encryption', async (t) => {
  const { tv, gladys, app } = await setup(t);
  const device = await createTv(gladys);

  assert.equal((await set(gladys, device, 'volume', 25)).success, true);
  assert.equal(tv.volume, 25);
  assert.equal(gladys.fake.lastState(id(UDN, 'volume')), 25);

  // Mute is a press: each one toggles what the TV reports.
  await set(gladys, device, 'mute', 1);
  assert.equal(tv.muted, true);
  assert.equal(gladys.fake.lastState(id(UDN, 'mute')), 1);
  await set(gladys, device, 'mute', 1);
  assert.equal(tv.muted, false);

  await set(gladys, device, 'source', 'hdmi1');
  await set(gladys, device, 'key', 'guide');
  await set(gladys, device, 'channel_up', 1);
  await set(gladys, device, 'app', '0010000200000001');
  assert.deepEqual(tv.keys, ['NRC_HDMI1-ONOFF', 'NRC_EPG-ONOFF', 'NRC_CH_UP-ONOFF']);
  assert.deepEqual(tv.apps, ['product_id=0010000200000001']);

  for (const [key, value] of [
    ['source', 'scart'],
    ['key', '__proto__'],
    ['app', 'FFFFFFFFFFFFFFFF'],
  ]) {
    const ack = await set(gladys, device, key, value);
    assert.equal(ack.success, false, `${key}=${value}`);
  }
  assert.equal(tv.keys.length, 3);

  // The TV's own applications join the dropdown.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const options = gladys.fake.discoveredDevices[0].features.find(
    (f) => f.external_id === id(UDN, 'app'),
  ).supported_options;
  assert.ok(options.some((o) => o.label === 'Demand 5'));
  assert.ok(app.tvs[0].apps.length === 3);
});

test('power: read just before, one key only when the state differs', async (t) => {
  const { tv, gladys } = await setup(t);
  const device = await createTv(gladys);

  await set(gladys, device, 'power', 1);
  assert.deepEqual(tv.keys, [], 'already on: nothing sent');

  await set(gladys, device, 'power', 0);
  assert.deepEqual(tv.keys, ['NRC_POWER-ONOFF']);
  assert.equal(tv.on, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gladys.fake.lastState(id(UDN, 'power')), 0);

  await set(gladys, device, 'power', 0);
  assert.equal(tv.keys.length, 1, 'already off: nothing sent');

  // Network standby: NRC still answers, the power key turns it on.
  await set(gladys, device, 'power', 1);
  assert.equal(tv.keys.length, 2);
  assert.equal(tv.on, true);
});

test('power on from deep standby: Wake-on-LAN, and never a power key after it', async (t) => {
  const { tv, gladys, app } = await setup(t, {
    config: { addresses: '127.0.0.1', mac_addresses: `127.0.0.1=${MAC}` },
  });
  const device = await createTv(gladys);
  tv.reachable = false;
  await app.poll();
  assert.equal(gladys.fake.lastState(id(UDN, 'power')), 0);

  const wake = gladys.wakeOnLan.bind(gladys);
  let woken = 0;
  gladys.wakeOnLan = async (mac, options) => {
    woken += 1;
    if (woken === 1) {
      tv.wake();
    }
    return wake(mac, options);
  };
  // Acked as soon as the packet is out; the TV is waited for in the background.
  assert.equal((await set(gladys, device, 'power', 1)).success, true);
  assert.deepEqual(gladys.fake.bodies('POST', '/network/wake'), [{ mac: MAC }]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(gladys.fake.lastState(id(UDN, 'power')), 1);
  assert.deepEqual(tv.keys, []);
});

test('a TV that does not wake up: the packet again, never a power key', async (t) => {
  const { tv, gladys, logs } = await setup(t, {
    config: {
      addresses: '127.0.0.1',
      mac_addresses: `127.0.0.1=${MAC}`,
      wake_broadcast: '192.168.1.255',
    },
  });
  const device = await createTv(gladys);
  tv.reachable = false;
  assert.equal((await set(gladys, device, 'power', 1)).success, true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const wakes = gladys.fake.bodies('POST', '/network/wake');
  assert.ok(wakes.length >= 2, `${wakes.length} packets`);
  assert.deepEqual(wakes[0], { mac: MAC, address: '192.168.1.255' });
  assert.deepEqual(tv.keys, []);
  assert.ok(logs.some((line) => /did not answer after Wake-on-LAN/.test(line)));
});

test('with a MAC, a TV in network standby gets the power key, then the packet', async (t) => {
  const { tv, gladys } = await setup(t, {
    config: { addresses: '127.0.0.1', mac_addresses: `127.0.0.1=${MAC}` },
  });
  const device = await createTv(gladys);
  tv.on = false;
  tv.dmrReachable = false;
  assert.equal((await set(gladys, device, 'power', 1)).success, true);
  assert.deepEqual(tv.keys, ['NRC_POWER-ONOFF']);
  assert.equal(gladys.fake.bodies('POST', '/network/wake').length, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(gladys.fake.lastState(id(UDN, 'power')), 1);
  assert.deepEqual(tv.keys, ['NRC_POWER-ONOFF'], 'one key only');
});

test('an unknown state is never published and never decides a toggle', async (t) => {
  const { tv, gladys, app } = await setup(t, {
    config: { addresses: '127.0.0.1', mac_addresses: `127.0.0.1=${MAC}` },
  });
  const device = await createTv(gladys);
  const published = gladys.fake.states.length;
  tv.dmrFault = true;
  await app.poll();
  assert.equal(gladys.fake.states.length, published, 'nothing published');
  for (const value of [0, 1]) {
    await set(gladys, device, 'power', value);
  }
  assert.deepEqual(tv.keys, [], 'no toggle on an unknown state');
  assert.equal(
    gladys.fake.bodies('POST', '/network/wake').length,
    1,
    'with a MAC, "on" still sends Wake-on-LAN',
  );
  // The way out: the raw key.
  assert.equal((await set(gladys, device, 'key', 'power')).success, true);
  assert.deepEqual(tv.keys, ['NRC_POWER-ONOFF']);
});

test('stop() cancels the background Wake-on-LAN wait', async (t) => {
  const { tv, gladys, app } = await setup(t, {
    config: { addresses: '127.0.0.1', mac_addresses: `127.0.0.1=${MAC}` },
    timings: { wakeWait: 5_000 },
  });
  const device = await createTv(gladys);
  tv.reachable = false;
  await set(gladys, device, 'power', 1);
  await app.stop();
  const sent = gladys.fake.bodies('POST', '/network/wake').length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(gladys.fake.bodies('POST', '/network/wake').length, sent);
});

test('power on from deep standby without a MAC says what is missing', async (t) => {
  const { tv, gladys } = await setup(t);
  const device = await createTv(gladys);
  tv.reachable = false;
  const ack = await set(gladys, device, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Wake-on-LAN/);
});

test('a silent TV: the command is acked within 4.5 s', async (t) => {
  const { tv, gladys } = await setup(t, {
    timings: { httpTimeout: TIMINGS.httpTimeout },
  });
  const device = await createTv(gladys);
  tv.silent = true;
  for (const [key, value] of [
    ['power', 1],
    ['volume', 20],
    ['key', 'up'],
  ]) {
    const started = Date.now();
    await set(gladys, device, key, value);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4500, `${key}: ${elapsed} ms`);
  }
});

test('a command waiting behind a long task is rejected at its deadline, never sent late', async (t) => {
  const { tv, gladys, app } = await setup(t, { timings: { commandBudget: 300 } });
  const device = await createTv(gladys);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const keys = tv.keys.length;
  // A pairing (or any long task) holds the queue of this TV for 800 ms.
  app.enqueue(UDN, () => new Promise((resolve) => setTimeout(resolve, 800)));
  const started = Date.now();
  const ack = await set(gladys, device, 'key', 'up');
  const elapsed = Date.now() - started;
  assert.equal(ack.success, false);
  assert.match(ack.error, /No time left/);
  assert.ok(elapsed < 700, `${elapsed} ms`);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(tv.keys.length, keys, 'not sent once the queue is free');
});

test('PIN pairing of an encrypted model, from the configuration screen', async (t) => {
  const { tv, gladys, logs, store } = await setup(t, { tvOptions: { encrypted: true } });
  const device = await createTv(gladys);
  assert.equal(gladys.fake.connectionStatus.connected, false, 'pairing needed');
  assert.match(gladys.fake.connectionStatus.message.fr, /appairer/);
  // Volume works before pairing (DMR is never encrypted); keys do not.
  assert.equal(gladys.fake.lastState(id(UDN, 'volume')), 12);
  assert.equal((await set(gladys, device, 'key', 'home')).success, false);

  const finishEarly = await gladys.fake.action('finish_pairing', { pin: PIN });
  assert.match(finishEarly.data.message.en, /No pairing in progress/);
  const badFormat = await gladys.fake.action('finish_pairing', { pin: '12a4' });
  assert.match(badFormat.data.message.en, /4 to 8 digits/);
  for (const key of ['start_pairing', 'finish_pairing']) {
    const old = await gladys.fake.action(key);
    assert.match(old.data.message.fr, /mettez Gladys à jour/, `${key} without fields`);
  }
  const badAddress = await gladys.fake.action('start_pairing', { address: 'not an ip!' });
  assert.match(badAddress.data.message.en, /IP address/);

  let ack = await gladys.fake.action('start_pairing', { address: '127.0.0.1' });
  assert.match(ack.data.message.en, /shows a PIN/);
  ack = await gladys.fake.action('finish_pairing', { pin: '0000' });
  assert.match(ack.data.message.en, /refused this PIN/);
  ack = await gladys.fake.action('finish_pairing', { pin: PIN });
  assert.match(ack.data.message.en, /No pairing in progress/, 'a refused PIN ends the attempt');

  await gladys.fake.action('start_pairing', { address: '127.0.0.1' });
  ack = await gladys.fake.action('finish_pairing', { pin: PIN });
  assert.match(ack.data.message.en, /is paired/);
  const saved = store.data.tvs[UDN];
  assert.ok(tv.pairings.get(saved.appId) === saved.encKey, 'keys kept in /data');
  assert.equal(gladys.fake.connectionStatus.connected, true);

  assert.equal((await set(gladys, device, 'key', 'home')).success, true);
  assert.equal(tv.keys.at(-1), 'NRC_HOME-ONOFF');
  const options = gladys.fake.discoveredDevices[0].features.find(
    (f) => f.external_id === id(UDN, 'app'),
  ).supported_options;
  assert.ok(options.some((o) => o.label === 'Media Player'));

  // Nothing secret in the logs, nor in what Gladys received.
  const secrets = [saved.encKey, saved.appId, PIN];
  const published = JSON.stringify(gladys.fake.requests);
  for (const secret of secrets) {
    assert.ok(!logs.some((line) => line.includes(secret)), 'logs');
    assert.ok(!published.includes(secret), 'Gladys requests');
  }
});

test('keys the TV refuses: reported once, the TV not asked again until a new pairing', async (t) => {
  const store = new MemoryStore({
    tvs: {
      [UDN]: {
        udn: UDN,
        host: '127.0.0.1',
        name: 'Living room TV',
        model: 'TX-55GZ950',
        encrypted: true,
        appId: 'APPGONE',
        encKey: Buffer.alloc(16, 7).toString('base64'),
      },
    },
  });
  const { tv, gladys, app } = await setup(t, { tvOptions: { encrypted: true }, store });
  const device = await createTv(gladys);
  assert.equal((await set(gladys, device, 'key', 'up')).success, false);
  assert.equal(app.tvs[0].keysRefused, true);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  const requests = tv.requests.length;
  assert.equal((await set(gladys, device, 'key', 'up')).success, false);
  assert.equal(tv.requests.length, requests, 'not asked again before the slow retry');
  assert.equal(tv.sessions.size, 0);
  // Volume still works.
  assert.equal((await set(gladys, device, 'volume', 3)).success, true);

  // The slow retry: once due, the keys are tried again; a session clears the mark.
  tv.pairings.set('APPGONE', Buffer.alloc(16, 7).toString('base64'));
  app.keysRetryAt.set(UDN, 0);
  assert.equal((await set(gladys, device, 'key', 'up')).success, true);
  assert.equal(app.tvs[0].keysRefused, false);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('"Action failed" on the session request with valid keys is a passing error', async (t) => {
  const keyword = Buffer.alloc(16, 9).toString('base64');
  const store = new MemoryStore({
    tvs: {
      [UDN]: {
        udn: UDN,
        host: '127.0.0.1',
        name: 'Living room TV',
        encrypted: true,
        appId: 'APPOK',
        encKey: keyword,
      },
    },
  });
  const { tv, gladys, app } = await setup(t, {
    tvOptions: { encrypted: true },
    store,
    timings: { refusalSpacing: 0 },
  });
  tv.pairings.set('APPOK', keyword);
  const device = await createTv(gladys);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const expire = () => {
    app.clients.get(UDN).shared.session = undefined;
  };

  expire();
  tv.sessionFaults = 1;
  assert.equal((await set(gladys, device, 'key', 'up')).success, false);
  assert.equal(app.tvs[0].keysRefused ?? false, false, 'one refusal is not a proof');
  assert.equal((await set(gladys, device, 'key', 'up')).success, true);

  // Three refusals while the TV is on: then the keys are marked refused.
  for (let i = 0; i < 3; i += 1) {
    expire();
    tv.sessionFaults = 1;
    await set(gladys, device, 'key', 'down');
  }
  assert.equal(app.tvs[0].keysRefused, true);
  assert.equal(gladys.fake.connectionStatus.connected, false);
});

test('an unreadable /data file is moved aside and reported', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'viera-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'viera.json'), '{ not json');
  const store = new FileStore({ dir });
  const { gladys } = await setup(t, { store });
  assert.equal(store.corrupted, true);
  assert.equal((await readFile(join(dir, 'viera.json.bad'), 'utf8')).trim(), '{ not json');
  assert.match(gladys.fake.connectionStatus.message.en, /viera\.json\.bad/);
  assert.equal(gladys.fake.discoveredDevices.length, 1, 'the typed address is found again');
});

test('SSDP search through Gladys: the address that answered, its MAC for Wake-on-LAN', async (t) => {
  const { gladys, store } = await setup(t, {
    config: {},
    scanResults: {
      ssdp: [
        {
          source_ip: '127.0.0.1',
          source_mac: 'A8-13-74-12-34-56',
          source_port: 1900,
          headers: 'HTTP/1.1 200 OK\r\nLOCATION: http://203.0.113.9/elsewhere.xml\r\n',
        },
        { source_ip: 'not-an-ip', headers: '' },
      ],
    },
  });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  const ack = await gladys.fake.action('find_tvs');
  assert.match(ack.data.message.en, /1 TV\(s\): Living room TV \(127\.0\.0\.1\)/);
  assert.deepEqual(gladys.fake.scans, [{ type: 'ssdp', timeout_seconds: 5 }]);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.data.tvs[UDN].mac, MAC);

  const check = await gladys.fake.action('check_tvs');
  assert.match(check.data.message.en, /on, volume 12, no pairing needed, Wake-on-LAN ready/);
  assert.match(check.data.message.fr, /allumée, volume 12/);
});

test('an address now answered by another TV is not commanded', async (t) => {
  const store = new MemoryStore({
    tvs: {
      [OTHER_UDN]: { udn: OTHER_UDN, host: '127.0.0.1', name: 'Bedroom TV', encrypted: false },
    },
  });
  const { gladys, app } = await setup(t, { config: {}, store });
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id(OTHER_UDN));
  await gladys.fake.deviceCreated(device);
  assert.equal(gladys.fake.lastState(id(OTHER_UDN, 'power')), 0);
  assert.equal(app.data.tvs[OTHER_UDN].host, '');
  const ack = await gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(OTHER_UDN, 'key')),
    'up',
  );
  assert.equal(ack.success, false);
});

test('invalid configuration entries are shown in the status', async (t) => {
  const { gladys } = await setup(t, {
    config: { addresses: '127.0.0.1, nope!', mac_addresses: '127.0.0.1=zz' },
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /nope!, 127\.0\.0\.1=zz/);
});

test('a TV turned off by hand: polling publishes it off, then back on', async (t) => {
  const { tv, gladys } = await setup(t);
  await createTv(gladys);
  tv.reachable = false;
  await gladys.fake.configUpdated({ addresses: '127.0.0.1' });
  assert.equal(gladys.fake.lastState(id(UDN, 'power')), 0);
  tv.reachable = true;
  await gladys.fake.configUpdated({ addresses: '127.0.0.1' });
  assert.equal(gladys.fake.lastState(id(UDN, 'power')), 1);
});
