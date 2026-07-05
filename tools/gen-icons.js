// Generates the Water Tank PWA icon set as flat-art PNGs with zero npm deps:
// per-pixel rasterization + manual PNG chunk assembly (zlib deflate, CRC32).
// A filled water tank with a wavy surface. Usage: node tools/gen-icons.js
// (writes into web/icons/). Adapted from the Crumb PWA's generator so the
// two apps share the same icon pipeline.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'web', 'icons');

/* ── PNG plumbing ── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// pixels = Uint8Array RGBA, row-major
function encodePng(width, height, pixels) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4)
      .copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── Flat water-tank art ── */

const BG      = [0xe0, 0xf2, 0xfe, 255]; // pale sky field (#e0f2fe)
const OUTLINE = [0x03, 0x69, 0xa1, 255]; // dark-cyan tank wall (#0369a1)
const WATER   = [0x0e, 0xa5, 0xe9, 255]; // cyan water (#0ea5e9)
const AIR     = [0xff, 0xff, 0xff, 255]; // white space above the waterline
const CLEAR   = [0, 0, 0, 0];

// One point sample. opts: cornerRadius (fraction of S, 0 = square bg),
// artScale (1 = normal, 0.6 = maskable safe zone).
function sample(x, y, S, opts) {
  if (opts.cornerRadius > 0) {
    const r = opts.cornerRadius * S;
    const dx = Math.max(Math.abs(x - S / 2) - (S / 2 - r), 0);
    const dy = Math.max(Math.abs(y - S / 2) - (S / 2 - r), 0);
    if (dx * dx + dy * dy > r * r) return CLEAR;
  }
  const k = opts.artScale;
  const cx = S / 2;
  const cy = S * 0.52;
  // Water tank: a rounded-rect body (taller than wide) with a bold wall and a
  // wavy waterline. Uses a rounded-rect signed-distance field — dist<0 inside,
  // and the wall is the band |dist| <= sw/2 straddling the edge.
  const hx = S * 0.22 * k;   // half width
  const hy = S * 0.30 * k;   // half height
  const rr = S * 0.06 * k;   // corner radius
  const sw = S * 0.05 * k;   // wall thickness
  const qx = Math.abs(x - cx) - (hx - rr);
  const qy = Math.abs(y - cy) - (hy - rr);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  const dist = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - rr;
  if (dist > sw / 2) return BG;          // outside the tank
  if (dist > -sw / 2) return OUTLINE;    // the tank wall
  const waterBase = cy - hy * 0.18;      // ~59% full
  const waterY = waterBase + S * 0.018 * k * Math.sin((x - cx) / (S * 0.05 * k));
  return y >= waterY ? WATER : AIR;      // water below the wavy surface, air above
}

// 3x3 supersampling with premultiplied-alpha averaging (clean rounded corners).
function render(S, opts) {
  const px = new Uint8Array(S * S * 4);
  const SS = 3;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, S, opts);
          const ca = c[3] / 255;
          r += c[0] * ca; g += c[1] * ca; b += c[2] * ca; a += c[3];
        }
      }
      const n = SS * SS;
      const i = (y * S + x) * 4;
      const aAvg = a / n;
      const w = aAvg > 0 ? (255 / aAvg) / n : 0;
      px[i] = Math.round(r * w);
      px[i + 1] = Math.round(g * w);
      px[i + 2] = Math.round(b * w);
      px[i + 3] = Math.round(aAvg);
    }
  }
  return px;
}

/* ── Emit ── */

const ICONS = [
  { file: 'icon-192.png', size: 192, cornerRadius: 0.21, artScale: 1 },
  { file: 'icon-512.png', size: 512, cornerRadius: 0.21, artScale: 1 },
  // maskable: field edge-to-edge, art inside the central 60% safe zone
  { file: 'icon-maskable-512.png', size: 512, cornerRadius: 0, artScale: 0.6 },
  // apple-touch: iOS applies its own mask, so opaque full-bleed square
  { file: 'apple-touch-icon-180.png', size: 180, cornerRadius: 0, artScale: 1 },
  { file: 'favicon-32.png', size: 32, cornerRadius: 0.21, artScale: 1 },
  { file: 'favicon-16.png', size: 16, cornerRadius: 0.21, artScale: 1 }
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const icon of ICONS) {
  const buf = encodePng(icon.size, icon.size, render(icon.size, icon));
  fs.writeFileSync(path.join(OUT_DIR, icon.file), buf);
  console.log(icon.file + ': ' + icon.size + 'x' + icon.size + ', ' + buf.length + ' bytes');
}
console.log('Done -> ' + OUT_DIR);
