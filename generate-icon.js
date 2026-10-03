// Generates icon.png (256x256): dark navy gradient + a cyan "pulse" waveform —
// echoes the $(pulse) status-bar glyph and the monitoring theme. Pure Node
// (zlib for deflate, manual CRC32) — no image dependencies.
const fs = require("fs");
const zlib = require("zlib");

const W = 256;
const H = 256;
const px = Buffer.alloc(W * H * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  // simple alpha blend over existing
  const ia = a / 255;
  px[i] = Math.round(px[i] * (1 - ia) + r * ia);
  px[i + 1] = Math.round(px[i + 1] * (1 - ia) + g * ia);
  px[i + 2] = Math.round(px[i + 2] * (1 - ia) + b * ia);
  px[i + 3] = 255;
}

// 1) vertical gradient background  #0f172a -> #1e3a5f
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const r = Math.round(15 + (30 - 15) * t);
  const g = Math.round(23 + (58 - 23) * t);
  const b = Math.round(42 + (95 - 42) * t);
  for (let x = 0; x < W; x++) set(x, y, r, g, b);
}

// 2) thick polyline (the pulse) in cyan #38bdf8
function disc(cx, cy, rad, r, g, b, a) {
  for (let y = -rad; y <= rad; y++)
    for (let x = -rad; x <= rad; x++)
      if (x * x + y * y <= rad * rad) set(cx + x, cy + y, r, g, b, a);
}
function line(x0, y0, x1, y1, rad, r, g, b) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    disc(Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f), rad, r, g, b, 255);
  }
}
const C = [56, 189, 248];
const pts = [
  [16, 150], [80, 150], [104, 64], [128, 204], [150, 110], [172, 150], [240, 150],
];
for (let i = 0; i < pts.length - 1; i++) {
  line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 7, C[0], C[1], C[2]);
}
// glow dot at the peak
disc(104, 64, 12, 125, 211, 252, 90);

// ---- PNG encode (8-bit RGBA, color type 6) ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// rows with filter byte 0
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync("icon.png", png);
console.log("wrote icon.png", png.length, "bytes");
