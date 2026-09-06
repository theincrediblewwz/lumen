/**
 * make_icon.js — 生成应用图标源图（纯 Node，无第三方依赖）
 *
 * 输出 app-icon.png（1024×1024），随后由 Tauri 官方工具生成各平台尺寸：
 *   npm run tauri -- icon app-icon.png
 *
 * 图案含义：一个根节点分叉出两个子节点 —— 正好是「脉络」的产品意象。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

const SIZE = 1024;
const INK = [46, 90, 78]; // 墨绿 #2E5A4E（与 styles.css 的 --accent 一致）
const PAPER = [255, 255, 255];

/* ───────── PNG 编码 ───────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────── 绘制 ───────── */
const buf = Buffer.alloc(SIZE * SIZE * 4);

/** 圆角矩形内部判定（半径取边长 22%） */
function inRoundedRect(x, y, r) {
  const pad = SIZE * 0.06;
  const w = SIZE - pad * 2;
  const rr = w * 0.22;
  if (x < pad || x > SIZE - pad || y < pad || y > SIZE - pad) return false;
  const dx = Math.min(x - pad, SIZE - pad - x);
  const dy = Math.min(y - pad, SIZE - pad - y);
  if (dx < rr && dy < rr) {
    return (rr - dx) ** 2 + (rr - dy) ** 2 <= rr * rr;
  }
  return true;
}

// 节点与连线（归一化坐标）
const NODES = [
  { x: 0.5, y: 0.26 },
  { x: 0.27, y: 0.68 },
  { x: 0.73, y: 0.68 },
];
const EDGES = [
  [0, 1],
  [0, 2],
];
const NODE_R = 0.085;
const LINE_W = 0.038;

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (!inRoundedRect(x, y)) {
      buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; // 透明
      continue;
    }
    let r = INK[0];
    let g = INK[1];
    let b = INK[2];
    const a = 255;

    const nx = x / SIZE;
    const ny = y / SIZE;

    // 连线
    for (const [s, t] of EDGES) {
      const d = distToSegment(
        nx,
        ny,
        NODES[s].x,
        NODES[s].y,
        NODES[t].x,
        NODES[t].y,
      );
      if (d <= LINE_W / 2) {
        r = PAPER[0];
        g = PAPER[1];
        b = PAPER[2];
      }
    }
    // 节点（后画，盖在连线上）
    for (const n of NODES) {
      if (Math.hypot(nx - n.x, ny - n.y) <= NODE_R) {
        r = PAPER[0];
        g = PAPER[1];
        b = PAPER[2];
      }
    }

    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
}

const out = encodePng(SIZE, SIZE, buf);
fs.writeFileSync('app-icon.png', out);
console.log('已生成 app-icon.png（1024×1024，' + out.length + ' 字节）');
