// -----------------------------------------------------------------------------
// The port of the panasonic-viera encryption: key schedules checked byte by
// byte against the library's loops, AES-CBC zero padding and HMAC framing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHmac } from 'node:crypto';
import {
  decryptPayload,
  derivePinKeys,
  deriveSessionKeys,
  encryptPayload,
  zeroPad,
} from '../src/viera/crypto.js';

const IV = Buffer.from([...Array(16).keys()]); // 00 01 02 ... 0f
const IV_BASE64 = IV.toString('base64');

// Fixed vectors produced in Python 3.13 by a hand port of
// panasonic_viera/remote_control.py (_derive_session_keys, the key schedule of
// authorize_pin_code, _encrypt_soap_payload and pad, with random bytes 01..0c)
// over a pure-Python AES-128 checked against the FIPS-197 vector (pycryptodome
// is not installed on the development machine).
const PY = {
  random: () => Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  keyword: 'EBESExQVFhcYGRobHB0eHw==',
  sessionKey: '12131011161714151a1b18191e1f1c1d',
  sessionText: '<X_ApplicationId>APP1234</X_ApplicationId>',
  sessionPayload:
    'tFoS5et0jrCChlUhgwQz95NELzOWD4hH8HUJOL5gzNqE1JPW0+NaVVFZJpuqWKLAui2HF71tVsxt2qH6imEQdpUBAqmhD0PA6TQdmo8FjC3do9g6vhadCHy5dcQhImcC',
  challenge: 'oKGio6SlpqeoqaqrrK2urw==',
  pinKey: '5c5d5e5f58595a5b5455565750515253',
  pinHmac: 'b76afa63162d034ee4892728b09b7ce207e8077d0a3fdd5f20660b558ae094f9',
  pinText: '<X_PinCode>4821</X_PinCode>',
  pinPayload:
    'CwQUML8qvPn/Jtw62KE2UPTHBW8PHg+5H1lmpi1P/jnDYOqHN/KnYH810IhZVxcsfhUyPS0CIxysAPDMbp73BesushD97Cj4MCk4fjbdsqE=',
};

test('fixed vectors from the Python library: keys and payloads identical', () => {
  const session = deriveSessionKeys(PY.keyword);
  assert.equal(session.key.toString('hex'), PY.sessionKey);
  assert.equal(encryptPayload(PY.sessionText, session, PY.random), PY.sessionPayload);
  assert.equal(decryptPayload(PY.sessionPayload, session), PY.sessionText);

  const pin = derivePinKeys(PY.challenge);
  assert.equal(pin.key.toString('hex'), PY.pinKey);
  assert.equal(pin.hmacKey.toString('hex'), PY.pinHmac);
  assert.equal(encryptPayload(PY.pinText, pin, PY.random), PY.pinPayload);
  assert.equal(decryptPayload(PY.pinPayload, pin), PY.pinText);
});

test('session keys: the keyword is the IV, swapped by pairs into the key, twice into the HMAC key', () => {
  const { key, iv, hmacKey } = deriveSessionKeys(IV_BASE64);
  assert.deepEqual(iv, IV);
  assert.deepEqual([...key], [2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13]);
  assert.deepEqual(hmacKey, Buffer.concat([IV, IV]));
  assert.throws(() => deriveSessionKeys('c2hvcnQ='), /16 bytes/);
});

test('PIN keys: inverted and reversed words, HMAC key masked as in libtvconnect', () => {
  const { key, hmacKey } = derivePinKeys(IV_BASE64);
  assert.deepEqual(
    [...key],
    [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12].map((b) => ~b & 0xff),
  );
  // hmac[i] = mask[i] ^ iv[(i + 2) & 15], hmac[i + 1] = mask[i + 1] ^ iv[(i + 3) & 15]...
  assert.equal(hmacKey.length, 32);
  assert.equal(hmacKey[0], 0x15 ^ 2);
  assert.equal(hmacKey[1], 0xc9 ^ 3);
  assert.equal(hmacKey[2], 0x5a ^ 0);
  assert.equal(hmacKey[3], 0xc2 ^ 1);
  assert.equal(hmacKey[16], 0xa5 ^ 2, 'the IV index wraps at 16');
  assert.equal(hmacKey[31], 0x54 ^ 13);
});

test('zero padding always adds at least one byte', () => {
  assert.equal(zeroPad(Buffer.alloc(5)).length, 16);
  assert.equal(zeroPad(Buffer.alloc(16)).length, 32, 'an aligned payload gets a whole block');
});

test('encryptPayload: header, length, text, zero padding, AES-CBC, HMAC appended', () => {
  const keys = deriveSessionKeys(IV_BASE64);
  const random = () => Buffer.alloc(12, 0xaa);
  const text = '<X_ApplicationId>APP1</X_ApplicationId>';
  const data = Buffer.from(encryptPayload(text, keys, random), 'base64');
  const ciphertext = data.subarray(0, data.length - 32);
  assert.equal(ciphertext.length % 16, 0);
  assert.deepEqual(
    data.subarray(data.length - 32),
    createHmac('sha256', keys.hmacKey).update(ciphertext).digest(),
  );
  const decipher = createDecipheriv('aes-128-cbc', keys.key, keys.iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.deepEqual(plain.subarray(0, 12), Buffer.alloc(12, 0xaa));
  assert.equal(plain.readUInt32BE(12), text.length);
  assert.equal(plain.subarray(16, 16 + text.length).toString('latin1'), text);
  assert.ok(plain.subarray(16 + text.length).every((b) => b === 0));
});

test('decryptPayload reads back what encryptPayload wrote, signature included', () => {
  for (const keys of [deriveSessionKeys(IV_BASE64), derivePinKeys(IV_BASE64)]) {
    for (const text of ['', '<X_PinCode>1234</X_PinCode>', 'x'.repeat(16), 'é ü']) {
      assert.equal(decryptPayload(encryptPayload(text, keys), keys), text);
    }
  }
  assert.throws(() => decryptPayload('AAAA', deriveSessionKeys(IV_BASE64)), /Invalid/);
  assert.throws(() => decryptPayload('', deriveSessionKeys(IV_BASE64)), /Invalid/);
});
