#!/usr/bin/env node
/**
 * make-icon.js — 生成 Android 启动图标（无损 PNG，不依赖任何图形库）
 *
 * 自己写 PNG 编码器的原因：只为了一张图标去装 sharp/canvas 不值得。
 * PNG 结构很简单：签名 + IHDR + IDAT(zlib 压缩的扫描线) + IEND。
 * 这里画一个圆角深色底 + 绿色声波，与播放器界面配色一致。
 *
 * 用法：node tools/make-icon.js [尺寸] [输出路径]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = Number(process.argv[2]) || 192;
const OUT = process.argv[3] || path.resolve(__dirname, '..', 'android', 'res', 'mipmap-xxhdpi', 'ic_launcher.png');

const BG = [12, 15, 20];        // #0c0f14
const ACCENT = [74, 222, 128];  // #4ade80

/** 画一帧 RGBA 像素 */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;          // 圆角半径
  const cx = size / 2, cy = size / 2;

  // 声波柱：5 根，中间最高
  const bars = 5;
  const barW = size * 0.062;
  const gap = size * 0.038;
  const totalW = bars * barW + (bars - 1) * gap;
  const left = cx - totalW / 2;
  const heights = [0.26, 0.46, 0.62, 0.42, 0.24].map((h) => h * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // 圆角矩形判定
      const insideRound = (() => {
        const rx = Math.min(x, size - 1 - x);
        const ry = Math.min(y, size - 1 - y);
        if (rx >= r || ry >= r) return true;
        const dx = r - rx, dy = r - ry;
        return dx * dx + dy * dy <= r * r;
      })();

      let color = insideRound ? BG : [0, 0, 0];
      let alpha = insideRound ? 255 : 0;

      // 画声波柱
      if (insideRound) {
        for (let b = 0; b < bars; b++) {
          const bx = left + b * (barW + gap);
          if (x >= bx && x <= bx + barW) {
            const hh = heights[b];
            if (y >= cy - hh / 2 && y <= cy + hh / 2) {
              color = ACCENT;
              // 柱子两端做一点圆角，观感更柔和
              const t = Math.abs(y - cy) / (hh / 2);
              if (t > 0.93) {
                const edge = (t - 0.93) / 0.07;
                color = [
                  Math.round(ACCENT[0] * (1 - edge) + BG[0] * edge),
                  Math.round(ACCENT[1] * (1 - edge) + BG[1] * edge),
                  Math.round(ACCENT[2] * (1 - edge) + BG[2] * edge),
                ];
              }
            }
          }
        }
      }

      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = alpha;
    }
  }
  return px;
}

/** 把 RGBA 打成 PNG */
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 6;    // 颜色类型：RGBA
  ihdr[10] = 0;   // 压缩方法
  ihdr[11] = 0;   // 滤波方法
  ihdr[12] = 0;   // 隔行扫描

  // 每行前面加一个滤波字节（0 = None）
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const idatData = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC32（PNG 规范）
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

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const png = encodePng(SIZE, render(SIZE));
  fs.writeFileSync(OUT, png);
  console.log(`已生成图标 ${OUT}（${SIZE}×${SIZE}，${png.length} 字节）`);
}

if (require.main === module) main();

module.exports = { encodePng, render };
