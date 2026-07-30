// Generates the application and tray icons as plain PNGs.
//
// Sable has zero runtime dependencies and we would rather not add an image
// library (or check in opaque binaries) just to draw two rounded squares, so
// the PNGs are encoded here from raw RGBA using only node:zlib.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, "assets");
mkdirSync(assets, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle, used for cheap anti-aliasing. */
function roundedRectDistance(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x) - (halfW - radius);
  const dy = Math.abs(y) - (halfH - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const plate = { r: 0x1a, g: 0x1b, b: 0x1f };
  const mark = { r: 0xc8, g: 0xb8, b: 0xff };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;
      const plateAlpha = clamp01(0.5 - roundedRectDistance(px, py, c * 0.94, c * 0.94, size * 0.24));

      // A crescent: one disc minus a second disc offset up and to the right.
      const outer = clamp01(0.5 - (Math.hypot(px, py) - size * 0.29));
      const cut = clamp01(0.5 - (Math.hypot(px - size * 0.13, py + size * 0.1) - size * 0.25));
      const markAlpha = clamp01(outer - cut) * plateAlpha;

      const i = (y * size + x) * 4;
      const r = Math.round(plate.r * (1 - markAlpha) + mark.r * markAlpha);
      const g = Math.round(plate.g * (1 - markAlpha) + mark.g * markAlpha);
      const b = Math.round(plate.b * (1 - markAlpha) + mark.b * markAlpha);
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(plateAlpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

writeFileSync(join(assets, "icon.png"), draw(512));
writeFileSync(join(assets, "tray.png"), draw(32));
writeFileSync(join(assets, "tray@2x.png"), draw(64));
console.log("wrote assets/icon.png, assets/tray.png, assets/tray@2x.png");
