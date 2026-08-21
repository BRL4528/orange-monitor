// Gera assets/icon.png (32x32) sem depender de libs de imagem: PNG cru + zlib nativo.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;
const CENTER = SIZE / 2;
const RADIUS = 14;
const RING = [255, 140, 26]; // #ff8c1a
const CORE = [255, 200, 120]; // brilho central

function pixel(x, y) {
  const dx = x - CENTER + 0.5;
  const dy = y - CENTER + 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > RADIUS) return [0, 0, 0, 0];
  const edge = RADIUS - dist;
  const alpha = Math.min(255, Math.round(edge * 90));
  const t = 1 - dist / RADIUS;
  const r = Math.round(RING[0] + (CORE[0] - RING[0]) * t * t);
  const g = Math.round(RING[1] + (CORE[1] - RING[1]) * t * t);
  const b = Math.round(RING[2] + (CORE[2] - RING[2]) * t * t);
  return [r, g, b, alpha];
}

function buildRawRGBA() {
  const rowBytes = SIZE * 4 + 1;
  const raw = Buffer.alloc(rowBytes * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // sem filtro
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = pixel(x, y);
      const off = rowStart + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  return raw;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildPng() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(buildRawRGBA());

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), buildPng());
console.log('assets/icon.png gerado');
