// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-blue gradient, a
// TV screen on its stand with a power symbol, and a row of remote keys.
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [10, 18, 40];
const BLUE = [0, 82, 165];
const WHITE = [255, 255, 255];
const SCREEN = [20, 40, 80];
const ACCENT = [80, 170, 255];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The colour of one pixel. */
function pixel(x, y) {
  let color = mix(DARK, BLUE, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The TV: a white frame, a dark screen, a stand.
  const frame = roundedBox(x, y, 400, 215, 230, 135, 14);
  color = mix(color, WHITE, smooth(0, frame));
  const screen = roundedBox(x, y, 400, 215, 216, 121, 6);
  color = mix(color, mix(SCREEN, BLUE, (y - 94) / 242), smooth(0, screen));
  const neck = roundedBox(x, y, 400, 370, 18, 20, 2);
  const foot = roundedBox(x, y, 400, 392, 90, 6, 6);
  color = mix(color, WHITE, Math.max(smooth(0, neck), smooth(0, foot)));
  // Power symbol on the screen: a ring open at the top, and a bar.
  const dx = x - 400;
  const dy = y - 220;
  const r = Math.hypot(dx, dy);
  const angle = Math.atan2(dx, -dy);
  const ring = smooth(9, Math.abs(r - 62)) * (Math.abs(angle) > 0.6 ? 1 : 0);
  const bar = smooth(9, Math.abs(dx)) * (dy > -86 && dy < -12 ? 1 : 0);
  color = mix(color, ACCENT, Math.max(ring, bar));
  // Five remote keys: volume -, mute, power, source, volume +.
  [240, 320, 400, 480, 560].forEach((px, i) => {
    const d = Math.hypot(x - px, y - 465);
    color = mix(color, i === 2 ? ACCENT : WHITE, smooth(24, d) * 0.9);
    color = mix(color, BLUE, smooth(9, d) * (i === 2 ? 0 : 0.8));
  });
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
