// Generates public/icon.png (56×56) — a rounded lolly-teal tile with a simple
// white "outward arrow" export glyph, encoded with zlib + hand-built PNG chunks
// so there is no image-library dependency.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 56;
const px = new Uint8Array(SIZE * SIZE * 4);

const inRoundedRect = (x, y, r) => {
  const min = 1, max = SIZE - 2;
  if (x < min || x > max || y < min || y > max) return false;
  const cx = x < min + r ? min + r : x > max - r ? max - r : x;
  const cy = y < min + r ? min + r : y > max - r ? max - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= min + r && x <= max - r) || (y >= min + r && y <= max - r)
    ? (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    : false;
};

// arrow: shaft from (20,36) → (34,22), head at top-right
const onShaft = (x, y) => Math.abs((x - 20) + (y - 36)) <= 2.2 && x >= 19 && x <= 37 && y >= 21 && y <= 37;
const onHead = (x, y) => x >= 30 && y <= 26 && x - 30 >= -(y - 26) - 1 && (x >= 34 || y <= 22);
// tray: open box bottom
const onTray = (x, y) =>
  (y >= 38 && y <= 41 && x >= 14 && x <= 42) ||
  (x >= 14 && x <= 17 && y >= 30 && y <= 41) ||
  (x >= 39 && x <= 42 && y >= 30 && y <= 41);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (!inRoundedRect(x, y, 12)) continue;
    // background: lolly teal-on-ink
    px[i] = 0x12; px[i + 1] = 0x14; px[i + 2] = 0x16; px[i + 3] = 255;
    if (onTray(x, y) || onShaft(x, y) || onHead(x, y)) {
      px[i] = 0x7e; px[i + 1] = 0xff; px[i + 2] = 0xf5;
    }
  }
}

// PNG assembly
const raw = new Uint8Array(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw.set(px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), y * (SIZE * 4 + 1) + 1);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), Buffer.from(data)])), 8 + data.length);
  return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '../public/icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
