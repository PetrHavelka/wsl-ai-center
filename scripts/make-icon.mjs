// Generates assets/wsl-ai-center.ico (16, 24, 32, 48, 64, 256 px): white "AI"
// on a rounded blue square, the same mark the tray icon draws. Fixed colors so
// it reads on any desktop or Start menu background. No dependencies:
//   node scripts/make-icon.mjs [--png <file>]   (--png also writes a 256 px preview)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "wsl-ai-center.ico");
const SIZES = [16, 24, 32, 48, 64, 256];
const SAMPLES = 4; // supersampling per axis

const BLUE = [0, 120, 212];
const WHITE = [255, 255, 255];
const STROKE = 0.1;
const STROKES = [ // letter strokes as segments in the unit square
  [0.39, 0.24, 0.22, 0.77], // A left
  [0.39, 0.24, 0.56, 0.77], // A right
  [0.29, 0.6, 0.49, 0.6], // A bar
  [0.74, 0.24, 0.74, 0.77] // I
];

function inRoundedRect(x, y, margin = 0.03, radius = 0.2) {
  const lo = margin + radius;
  const hi = 1 - margin - radius;
  const dx = Math.max(lo - x, 0, x - hi);
  const dy = Math.max(lo - y, 0, y - hi);
  return x >= margin && x <= 1 - margin && y >= margin && y <= 1 - margin && dx * dx + dy * dy <= radius * radius;
}

function nearSegment(x, y, [x1, y1, x2, y2], width) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy)));
  const dx = x - (x1 + t * vx);
  const dy = y - (y1 + t * vy);
  return dx * dx + dy * dy <= (width / 2) ** 2;
}

/** RGBA pixels, top-down rows. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const n = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!inRoundedRect(x, y)) continue;
          if (STROKES.some(s => nearSegment(x, y, s, STROKE))) fg++;
          else bg++;
        }
      }
      const alpha = (bg + fg) / n;
      const i = (py * size + px) * 4;
      if (alpha > 0) {
        for (let c = 0; c < 3; c++) pixels[i + c] = Math.round((BLUE[c] * bg + WHITE[c] * fg) / (bg + fg));
      }
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** Classic 32-bit DIB entry (BGRA, bottom-up, plus an all-zero AND mask). */
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND mask height
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  const andRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, xor, Buffer.alloc(andRow * size)]);
}

const images = SIZES.map(size => {
  const rgba = render(size);
  return { size, rgba, data: size >= 256 ? png(size, rgba) : dib(size, rgba) };
});

const dir = Buffer.alloc(6);
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([dir, ...entries, ...images.map(i => i.data)]));
console.log(`wrote ${OUT}`);

const pngArg = process.argv.indexOf("--png");
if (pngArg > 0 && process.argv[pngArg + 1]) {
  const big = images.at(-1);
  writeFileSync(process.argv[pngArg + 1], png(big.size, big.rgba));
  console.log(`wrote ${process.argv[pngArg + 1]}`);
}
