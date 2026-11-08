// アイコン生成 — 外部依存なしで PNG をエンコードし、
// assets/icon.png / icon.ico / icon.icns を出力する。
// モチーフ: 縦書きの段（右から左へ短くなる3列）＋落款（ハンコ）印。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// ---------- pixel buffer ----------

const rgb = (hex) => [
  (hex >> 16) & 255,
  (hex >> 8) & 255,
  hex & 255,
];

const BG = rgb(0x232733); // アプリのダークテーマ地
const PAPER = rgb(0xefe9db); // 用紙色
const ACCENT = rgb(0xaa0066); // --accent（ハンコ）

function makeCanvas(size) {
  return new Uint8Array(size * size * 4); // transparent black
}

// 角丸矩形の包含判定（ピクセル中心基準）
function inRoundRect(x, y, rx, ry, w, h, rad) {
  if (x < rx || x >= rx + w || y < ry || y >= ry + h) return false;
  const cx =
    x < rx + rad ? rx + rad : x >= rx + w - rad ? rx + w - rad : x;
  const cy =
    y < ry + rad ? ry + rad : y >= ry + h - rad ? ry + h - rad : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function fillRoundRect(px, size, rx, ry, w, h, rad, [r, g, b]) {
  for (let y = Math.floor(ry); y < ry + h; y++) {
    for (let x = Math.floor(rx); x < rx + w; x++) {
      if (!inRoundRect(x + 0.5, y + 0.5, rx, ry, w, h, rad)) continue;
      const i = (y * size + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
}

// 1024基準の設計図を任意サイズへスケール描画
function render(size) {
  const k = size / 1024;
  const px = makeCanvas(size);
  fillRoundRect(px, size, 0, 0, size, size, 190 * k, BG);
  // 縦書き3段 — 右から左へ段が短くなる（文章の終わりへ向かう形）
  const cols = [
    { x: 656, h: 590 }, // 最右（書き出し・いちばん長い）
    { x: 456, h: 470 },
    { x: 256, h: 350 },
  ];
  for (const c of cols)
    fillRoundRect(px, size, c.x * k, 210 * k, 110 * k, c.h * k, 40 * k, PAPER);
  // ハンコ — 最終段の下に捺す落款
  fillRoundRect(px, size, 266 * k, 630 * k, 90 * k, 90 * k, 14 * k, ACCENT);
  return px;
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
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

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO（PNG-in-ICO / Vista+） ----------

function encodeIco(png256) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  // width/height 0 = 256
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png256.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([dir, entry, png256]);
}

// ---------- ICNS（PNG 圧縮チャンク / macOS 10.7+） ----------

function encodeIcns(entries) {
  const chunks = entries.map(([type, png]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------- main ----------

mkdirSync(ASSETS, { recursive: true });
const png = (s) => encodePng(render(s), s);

const png1024 = png(1024);
const png512 = png(512);
const png256 = png(256);
const png128 = png(128);

writeFileSync(join(ASSETS, 'icon.png'), png1024);
writeFileSync(join(ASSETS, 'icon.ico'), encodeIco(png256));
writeFileSync(
  join(ASSETS, 'icon.icns'),
  encodeIcns([
    ['ic07', png128],
    ['ic08', png256],
    ['ic09', png512],
    ['ic10', png1024],
  ]),
);
console.log('wrote assets/icon.png, icon.ico, icon.icns');
