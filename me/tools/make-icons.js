'use strict';
/**
 * Generates the PWA icon set with zero dependencies.
 * Run: node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- geometry ---- */

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function roundRectSdf(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

/* ------------------------------------------------------------------ draw ---- */

function draw(size, { maskable = false } = {}) {
  const SS = 3;
  const buf = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : size * 0.225;
  const strokeHalf = (size / 24) * 1.35; /* 2.7 units of 24 */
  const S = size / 24;

  const segA = [5.2, 12.6, 10.1, 17.4].map((v) => v * S);
  const segB = [10.1, 17.4, 19.0, 7.4].map((v) => v * S);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const sdf = maskable ? -1 : roundRectSdf(px, py, size, radius);
          const bgAlpha = Math.max(0, Math.min(1, 0.5 - sdf));
          if (bgAlpha <= 0) continue;

          /* diagonal gradient: bright green -> deep green */
          const t = Math.max(0, Math.min(1, (px / size) * 0.55 + (py / size) * 0.45));
          let pr = Math.round(0x3d + (0x07 - 0x3d) * t);
          let pg = Math.round(0xe0 + (0x7a - 0xe0) * t);
          let pb = Math.round(0x86 + (0x45 - 0x86) * t);

          /* soft highlight top-left */
          const hl = Math.max(0, 1 - Math.hypot(px - size * 0.2, py - size * 0.14) / (size * 0.75));
          pr = Math.min(255, Math.round(pr + hl * 26));
          pg = Math.min(255, Math.round(pg + hl * 26));
          pb = Math.min(255, Math.round(pb + hl * 20));

          const d = Math.min(segDist(px, py, ...segA), segDist(px, py, ...segB));
          const checkAlpha = Math.max(0, Math.min(1, strokeHalf + 0.6 - d));
          if (checkAlpha > 0) {
            const ca = checkAlpha;
            pr = Math.round(pr * (1 - ca) + 255 * ca);
            pg = Math.round(pg * (1 - ca) + 255 * ca);
            pb = Math.round(pb * (1 - ca) + 255 * ca);
          }

          r += pr * bgAlpha;
          g += pg * bgAlpha;
          b += pb * bgAlpha;
          a += bgAlpha;
        }
      }

      const samples = SS * SS;
      const idx = (y * size + x) * 4;
      const alpha = a / samples;
      if (alpha <= 0.001) continue;
      buf[idx] = Math.min(255, Math.round(r / a));
      buf[idx + 1] = Math.min(255, Math.round(g / a));
      buf[idx + 2] = Math.min(255, Math.round(b / a));
      buf[idx + 3] = Math.min(255, Math.round(alpha * 255));
    }
  }
  return encodePng(size, size, buf);
}

/* ------------------------------------------------------------------ main ---- */

fs.mkdirSync(OUT, { recursive: true });

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
  ['favicon-32.png', 32, {}],
];

for (const [name, size, opts] of targets) {
  fs.writeFileSync(path.join(OUT, name), draw(size, opts));
  console.log(`wrote icons/${name} (${size}x${size})`);
}
