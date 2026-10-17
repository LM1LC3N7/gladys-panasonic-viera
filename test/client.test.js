// -----------------------------------------------------------------------------
// VieraClient against the fake TV on the loopback interface: the clear
// models, the PIN pairing and the encrypted session of the recent ones.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { VieraClient } from '../src/viera/client.js';
import { ERROR_KINDS, MAX_BODY } from '../src/viera/http.js';
import { PIN, UDN, startFakeTv } from './fixtures/fakeTv.js';

async function setup(t, options) {
  const tv = await startFakeTv(options);
  t.after(() => tv.close());
  const client = new VieraClient({ host: '127.0.0.1', port: tv.port, timeoutMs: 2000 });
  return { tv, client };
}

test('a model without encryption: description, volume, mute, keys, apps', async (t) => {
  const { tv, client } = await setup(t);
  assert.equal((await client.describe()).udn, UDN);
  assert.equal(await client.detectEncryption(), false);
  assert.equal(await client.getVolume(), 12);
  await client.setVolume(30);
  assert.equal(tv.volume, 30);
  await client.setMute(true);
  assert.equal(await client.getMute(), true);
  await client.sendKey('hdmi2');
  await client.launchApp('0010000200000001');
  await client.launchApp('1063');
  assert.deepEqual(tv.keys, ['NRC_HDMI2-ONOFF']);
  assert.deepEqual(tv.apps, ['product_id=0010000200000001', 'resource_id=1063']);
  assert.equal((await client.getApps()).length, 3);
  await assert.rejects(client.sendKey('format_disk'), /Unknown key/);
  await assert.rejects(client.launchApp('<x>'), /Invalid application/);
  await assert.rejects(client.setVolume(101), /0 to 100/);
});

test('an encrypted model refuses NRC commands until paired; DMR works', async (t) => {
  const { client } = await setup(t, { encrypted: true });
  assert.equal(await client.detectEncryption(), true);
  assert.equal(await client.getVolume(), 12);
  await assert.rejects(client.sendKey('power'), { kind: ERROR_KINDS.PAIRING_REQUIRED });
});

test('PIN pairing, then encrypted commands with increasing sequence numbers', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.detectEncryption();
  const challenge = await client.requestPin('Gladys');
  const credentials = await client.authorizePin(challenge, PIN);
  assert.ok(tv.pairings.has(credentials.appId));
  assert.equal(tv.pairings.get(credentials.appId), credentials.encKey);
  await client.sendKey('volume_up');
  await client.sendKey('mute');
  await client.launchApp('0070000200180001');
  assert.deepEqual(tv.keys, ['NRC_VOLUP-ONOFF', 'NRC_MUTE-ONOFF']);
  assert.deepEqual(tv.apps, ['product_id=0070000200180001']);
  assert.deepEqual(
    tv.calls.map((c) => c.sequence),
    [2, 3, 4],
  );
  const apps = await client.getApps();
  assert.deepEqual(
    apps.map((a) => a.name),
    ['Media Player', 'Netflix', 'Demand 5'],
  );

  // A new client with the stored credentials opens its own session.
  const again = new VieraClient({
    host: '127.0.0.1',
    port: tv.port,
    encrypted: true,
    credentials,
  });
  await again.sendKey('home');
  assert.equal(tv.keys.at(-1), 'NRC_HOME-ONOFF');
});

test('a wrong PIN is told apart', async (t) => {
  const { client } = await setup(t, { encrypted: true });
  const challenge = await client.requestPin();
  await assert.rejects(client.authorizePin(challenge, '0000'), { kind: ERROR_KINDS.INVALID_PIN });
  assert.equal(client.paired, false);
});

test('"No such session" renews the session once, restoring the sequence', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.authorizePin(await client.requestPin(), PIN);
  assert.equal(tv.sessionCount, 0, 'the session is opened by the caller, after saving');
  await client.sendKey('up');
  tv.refuseCommands = 1;
  await client.sendKey('down');
  assert.deepEqual(tv.keys, ['NRC_UP-ONOFF', 'NRC_DOWN-ONOFF']);
  assert.equal(tv.sessionCount, 2, 'a second session was opened');
  tv.refuseCommands = 2;
  await assert.rejects(client.sendKey('left'), { kind: ERROR_KINDS.FAULT });
  assert.equal(tv.calls.at(-1).sequence, 2, 'the renewed session started over');
  assert.equal(client.session, undefined, 'dropped: the next command opens a new one');
  assert.ok(!tv.keys.includes('NRC_LEFT-ONOFF'));
});

test('"No such session" in the HTTP reason phrase only (no fault body) renews too', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.authorizePin(await client.requestPin(), PIN);
  await client.sendKey('up');
  tv.expiry = 'phrase';
  tv.refuseCommands = 1;
  await client.sendKey('down');
  assert.deepEqual(tv.keys, ['NRC_UP-ONOFF', 'NRC_DOWN-ONOFF']);
  assert.equal(tv.sessionCount, 2);
});

test('after an explicit expiry the power key is sent again: the TV did not run it', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.authorizePin(await client.requestPin(), PIN);
  await client.sendKey('up');
  tv.refuseCommands = 1;
  await client.sendKey('power');
  assert.deepEqual(tv.keys, ['NRC_UP-ONOFF', 'NRC_POWER-ONOFF'], 'run once by the TV');
  assert.equal(tv.sessionCount, 2);
});

test('any other fault (e.g. 401 Invalid Action) is not resent, the next command opens a new session', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.authorizePin(await client.requestPin(), PIN);
  await client.sendKey('up');
  tv.failCommands = 1;
  tv.failWith = [401, 'Invalid Action'];
  const calls = tv.calls.length;
  await assert.rejects(client.sendKey('power'), { description: 'Invalid Action' });
  assert.equal(tv.calls.length, calls + 1, 'power sent once');
  assert.equal(client.session, undefined, 'session dropped');
  await client.sendKey('right');
  assert.equal(tv.sessionCount, 2, 'the next command opens a new session');
  assert.deepEqual(tv.keys, ['NRC_UP-ONOFF', 'NRC_RIGHT-ONOFF']);

  tv.failCommands = 1;
  tv.failWith = [501, 'Action failed'];
  await assert.rejects(client.sendKey('down'), { description: 'Action failed' });
  await client.sendKey('left');
  assert.equal(tv.sessionCount, 3);
});

test('a timeout after the connection was accepted is ambiguous: never resent', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.authorizePin(await client.requestPin(), PIN);
  await client.sendKey('up');
  tv.silent = true;
  const requests = tv.requests.length;
  await assert.rejects(client.withBudget(300).sendKey('power'), { kind: ERROR_KINDS.TIMEOUT });
  assert.equal(tv.requests.length, requests + 1, 'sent once');
  // The number the TV may have used is not given back (as the library does).
  assert.equal(client.session.sequence, 3, 'kept after a timeout');
  tv.silent = false;
  await client.sendKey('down');
  assert.equal(tv.calls.at(-1).sequence, 4);
  assert.equal(tv.sessionCount, 1, 'same session');
});

test('keys the TV explicitly refuses are reported, not retried in a loop', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  const credentials = await client.authorizePin(await client.requestPin(), PIN);
  tv.pairings.clear();
  const fresh = new VieraClient({ host: '127.0.0.1', port: tv.port, encrypted: true, credentials });
  await assert.rejects(fresh.sendKey('up'), { kind: ERROR_KINDS.KEYS_REFUSED });
  assert.equal(tv.calls.length, 0);
});

test('"Action failed" on the session request with valid keys is a passing refusal', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  let sessions = 0;
  client.onSession = () => {
    sessions += 1;
  };
  await client.authorizePin(await client.requestPin(), PIN);
  tv.sessionFaults = 1;
  await assert.rejects(client.sendKey('up'), { kind: ERROR_KINDS.SESSION_REFUSED });
  await client.sendKey('up');
  assert.equal(sessions, 1);
  assert.deepEqual(tv.keys, ['NRC_UP-ONOFF']);
});

test('a budgeted view shares the session and ends in time', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.authorizePin(await client.requestPin(), PIN);
  await client.withBudget(2000).sendKey('up');
  await client.sendKey('down');
  assert.equal(tv.sessionCount, 1, 'one session for both views');
  tv.silent = true;
  const started = Date.now();
  // The connection is accepted, then nothing: unknown, not "off".
  await assert.rejects(client.withBudget(300).getMute(), { kind: ERROR_KINDS.TIMEOUT });
  assert.ok(Date.now() - started < 1000);
});

test('a TV in standby (connection closed, or nothing listening) is unreachable', async (t) => {
  const { tv, client } = await setup(t);
  tv.reachable = false;
  await assert.rejects(client.getVolume(), { kind: ERROR_KINDS.UNREACHABLE });

  // A port nobody listens on.
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const closed = new VieraClient({ host: '127.0.0.1', port, timeoutMs: 1000 });
  await assert.rejects(closed.getMute(), { kind: ERROR_KINDS.UNREACHABLE });
});

test('a silent TV times out', async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  server.on('connection', (socket) => sockets.push(socket));
  t.after(
    () =>
      new Promise((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(resolve);
      }),
  );
  const client = new VieraClient({
    host: '127.0.0.1',
    port: server.address().port,
    timeoutMs: 200,
  });
  await assert.rejects(client.getMute(), /timeout/);
});

test('an answer above 64 KB is refused', async (t) => {
  const server = createHttpServer((req, res) => {
    res.writeHead(200);
    res.end('<a>'.repeat(30_000));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(MAX_BODY, 64 * 1024);
  const client = new VieraClient({ host: '127.0.0.1', port: server.address().port });
  await assert.rejects(client.describe(), /too large/);
});
