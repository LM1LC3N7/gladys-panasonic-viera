import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost, parseMac } from '../src/config.js';

test('parseHost: IPv4, host names, pasted URLs; the rest refused', () => {
  assert.equal(parseHost(' 192.168.1.40 '), '192.168.1.40');
  assert.equal(parseHost('http://192.168.1.40:55000/nrc/ddd.xml'), '192.168.1.40');
  assert.equal(parseHost('Viera-Salon.lan'), 'viera-salon.lan');
  assert.equal(parseHost('192.168.1.300'), undefined);
  assert.equal(parseHost('bad host'), undefined);
  assert.equal(parseHost(''), undefined);
  assert.equal(parseHost('a/<script>'), 'a');
});

test('parseMac: separators, case; broadcast and zero refused', () => {
  assert.equal(parseMac('A8-13-74-12-34-56'), 'a8:13:74:12:34:56');
  assert.equal(parseMac('a81374123456'), 'a8:13:74:12:34:56');
  assert.equal(parseMac('ff:ff:ff:ff:ff:ff'), undefined);
  assert.equal(parseMac('00:00:00:00:00:00'), undefined);
  assert.equal(parseMac('a8:13:74'), undefined);
});

test('normalizeConfig: lists, MAC pairs, bounds, invalid entries kept for the status', () => {
  const config = normalizeConfig({
    addresses: '192.168.1.40, 192.168.1.40;tv.lan oops!',
    mac_addresses: '192.168.1.40=a8:13:74:12:34:56, nonsense',
    poll_interval: 1,
  });
  assert.deepEqual(config.addresses, ['192.168.1.40', 'tv.lan']);
  assert.deepEqual(config.macs, { '192.168.1.40': 'a8:13:74:12:34:56' });
  assert.deepEqual(config.invalid, ['oops!', 'nonsense']);
  assert.equal(config.pollInterval, 5);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 300);
  assert.deepEqual(normalizeConfig(), {
    addresses: [],
    macs: {},
    wakeAddress: undefined,
    invalid: [],
    pollInterval: 10,
  });
  assert.equal(normalizeConfig({ wake_broadcast: '192.168.1.255' }).wakeAddress, '192.168.1.255');
  assert.deepEqual(normalizeConfig({ wake_broadcast: 'everyone' }).invalid, ['everyone']);
});
