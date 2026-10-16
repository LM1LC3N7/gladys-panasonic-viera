// -----------------------------------------------------------------------------
// The encryption of the Panasonic Viera "network remote control" (NRC) on the
// models that ask for a PIN (2018 and later, e.g. the FZ, GZ, HZ series):
// AES-128-CBC with zero padding, HMAC-SHA-256 appended, and the key schedules
// of the PIN exchange and of the session. Ported to JavaScript from
// florianholzapfel/panasonic-viera (MIT, see THIRD_PARTY_NOTICES.md), byte for
// byte, so a TV that works with that library works with this one.
//
// Pure functions over Buffers: no I/O, no state, nothing logged.
// -----------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const BLOCK = 16;

// HMAC key mask of the PIN exchange (taken from libtvconnect.so by the
// panasonic-viera authors).
const PIN_HMAC_MASK = Buffer.from([
  0x15, 0xc9, 0x5a, 0xc2, 0xb0, 0x8a, 0xa7, 0xeb, 0x4e, 0x22, 0x8f, 0x81, 0x1e, 0x34, 0xd0, 0x4f,
  0xa5, 0x4b, 0xa7, 0xdc, 0xac, 0x98, 0x79, 0xfa, 0x8a, 0xcd, 0xa3, 0xfc, 0x24, 0x4f, 0x38, 0x54,
]);

/**
 * Zero padding up to the next block, always at least one byte: a payload
 * already aligned gets a whole block of zeros (what the library sends, and
 * what lets the reader cut at the first NUL).
 */
export function zeroPad(buffer) {
  const padding = BLOCK - (buffer.length % BLOCK);
  return Buffer.concat([buffer, Buffer.alloc(padding)]);
}

/**
 * The session keys derived from the `X_Keyword` the TV gave at pairing
 * (base64, 16 bytes): the IV is the keyword itself, the AES key its bytes
 * swapped by pairs within each 4-byte word, the HMAC key the IV twice.
 * @returns {{ key: Buffer, iv: Buffer, hmacKey: Buffer }}
 */
export function deriveSessionKeys(keywordBase64) {
  const iv = Buffer.from(String(keywordBase64 ?? ''), 'base64');
  if (iv.length !== BLOCK) {
    throw new Error('Invalid encryption key: 16 bytes expected');
  }
  const key = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i += 4) {
    key[i] = iv[i + 2];
    key[i + 1] = iv[i + 3];
    key[i + 2] = iv[i];
    key[i + 3] = iv[i + 1];
  }
  return { key, iv, hmacKey: Buffer.concat([iv, iv]) };
}

/**
 * The keys of the PIN exchange, derived from the challenge the TV answered to
 * `X_DisplayPinCode` (base64, 16 bytes): the AES key is the challenge
 * inverted and reversed within each 4-byte word, the HMAC key the challenge
 * mixed with a fixed mask.
 * @returns {{ key: Buffer, iv: Buffer, hmacKey: Buffer }}
 */
export function derivePinKeys(challengeBase64) {
  const iv = Buffer.from(String(challengeBase64 ?? ''), 'base64');
  if (iv.length !== BLOCK) {
    throw new Error('Invalid challenge: 16 bytes expected');
  }
  const key = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i += 4) {
    key[i] = ~iv[i + 3] & 0xff;
    key[i + 1] = ~iv[i + 2] & 0xff;
    key[i + 2] = ~iv[i + 1] & 0xff;
    key[i + 3] = ~iv[i] & 0xff;
  }
  const hmacKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 4) {
    hmacKey[i] = PIN_HMAC_MASK[i] ^ iv[(i + 2) & 0xf];
    hmacKey[i + 1] = PIN_HMAC_MASK[i + 1] ^ iv[(i + 3) & 0xf];
    hmacKey[i + 2] = PIN_HMAC_MASK[i + 2] ^ iv[i & 0xf];
    hmacKey[i + 3] = PIN_HMAC_MASK[i + 3] ^ iv[(i + 1) & 0xf];
  }
  return { key, iv, hmacKey };
}

/**
 * Encrypts one SOAP fragment: 12 random bytes, the fragment length (4 bytes,
 * big endian), the fragment (Latin-1, as the library sends it), zero padded,
 * AES-128-CBC, then the HMAC-SHA-256 of the ciphertext appended; base64.
 * @param {string} text
 * @param {{ key: Buffer, iv: Buffer, hmacKey: Buffer }} keys
 * @param {(size: number) => Buffer} [random] for the tests
 */
export function encryptPayload(text, { key, iv, hmacKey }, random = randomBytes) {
  const data = Buffer.from(String(text), 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const plain = zeroPad(Buffer.concat([random(12), length, data]));
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const signature = createHmac('sha256', hmacKey).update(ciphertext).digest();
  return Buffer.concat([ciphertext, signature]).toString('base64');
}

/**
 * Decrypts what the TV answers (`X_EncResult`, `X_AuthResult`): the 16-byte
 * header is dropped and the text cut at the first NUL (the zero padding).
 * Like the library, the whole buffer is deciphered, signature blocks included:
 * they land after the padding and are cut with it.
 * @returns {string}
 */
export function decryptPayload(base64, { key, iv }) {
  const data = Buffer.from(String(base64 ?? '').trim(), 'base64');
  if (data.length === 0 || data.length % BLOCK !== 0) {
    throw new Error('Invalid encrypted payload');
  }
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).subarray(BLOCK);
  const end = plain.indexOf(0);
  return plain.subarray(0, end === -1 ? plain.length : end).toString('latin1');
}
