// Generates desktop/build/icon.ico from a source PNG by embedding the PNG bytes
// directly into a single-image ICO entry. ICO supports PNG-compressed entries;
// setting the width/height bytes to 0 signals 256x256.
//
// Source: ../../public/icons/icon-512.png. If that file is missing, a 256x256
// solid dark-navy (#0f172a) PNG is generated from scratch and wrapped instead.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SRC_PNG = path.join(__dirname, "../../public/icons/icon-512.png");
const OUT_ICO = path.join(__dirname, "icon.ico");

// --- Minimal PNG encoder (used only as a fallback) ----------------------------

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makeSolidPng(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image: each scanline prefixed with a filter byte (0 = none).
  const rowLen = size * 3 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Acquire the source PNG ---------------------------------------------------

let pngBytes;
if (fs.existsSync(SRC_PNG)) {
  pngBytes = fs.readFileSync(SRC_PNG);
  console.log(`Using source PNG: ${SRC_PNG} (${pngBytes.length} bytes)`);
} else {
  console.log(`Source PNG not found at ${SRC_PNG}; generating solid #0f172a PNG.`);
  pngBytes = makeSolidPng(256, 0x0f, 0x17, 0x2a);
}

// --- Wrap the PNG into a single-image ICO ------------------------------------

// ICONDIR header (6 bytes): reserved=0, type=1 (icon), count=1.
const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0);
iconDir.writeUInt16LE(1, 2);
iconDir.writeUInt16LE(1, 4);

// ICONDIRENTRY (16 bytes).
const entry = Buffer.alloc(16);
entry[0] = 0; // width: 0 means 256
entry[1] = 0; // height: 0 means 256
entry[2] = 0; // color count (0 = >= 256 colors)
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(pngBytes.length, 8); // size of image data
entry.writeUInt32LE(6 + 16, 12); // offset to image data (after header + entry)

const ico = Buffer.concat([iconDir, entry, pngBytes]);
fs.writeFileSync(OUT_ICO, ico);
console.log(`Wrote ${OUT_ICO} (${ico.length} bytes)`);
