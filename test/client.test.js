// -----------------------------------------------------------------------------
// VieraClient against the fake TV on the loopback interface: the clear
// models, the PIN pairing and the encrypted session of the recent ones.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { VieraClient } from '../src/viera/client.js';
import { ERROR_KINDS } from '../src/viera/http.js';
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

test('a refused encrypted command renews the session once, restoring the sequence', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  await client.authorizePin(await client.requestPin(), PIN);
  await client.sendKey('up');
  tv.refuseCommands = 1;
  await client.sendKey('down');
  assert.deepEqual(tv.keys, ['NRC_UP-ONOFF', 'NRC_DOWN-ONOFF']);
  assert.equal(tv.sessions.size, 2, 'a second session was opened');
  tv.refuseCommands = 2;
  await assert.rejects(client.sendKey('left'), { kind: ERROR_KINDS.FAULT });
  assert.equal(client.session.sequence, tv.calls.at(-1).sequence - 1, 'sequence restored');
});

test('keys the TV no longer knows are reported, not retried in a loop', async (t) => {
  const { tv, client } = await setup(t, { encrypted: true });
  const credentials = await client.authorizePin(await client.requestPin(), PIN);
  tv.pairings.clear();
  const fresh = new VieraClient({ host: '127.0.0.1', port: tv.port, encrypted: true, credentials });
  await assert.rejects(fresh.sendKey('up'), { kind: ERROR_KINDS.KEYS_REFUSED });
  assert.equal(tv.calls.length, 0);
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
