#!/usr/bin/env node
// 离线点云预览: 把 PLY 泼溅点做正交投影, 输出 PNG (无 GL 依赖, 纯 JS + zlib)
// 用法: node tools/preview-ply.mjs [outPrefix]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plyPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'scene.ply');
const prefix = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'preview');

const b = readFileSync(plyPath);
const idx = b.indexOf('end_header\n') + 11;
const body = b.subarray(idx);
const f = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
const n = f.length / 17;

// 读取点
const pts = new Float32Array(n * 6); // x y z r g b (sRGB 0..1)
for (let i = 0; i < n; i++) {
    const o = i * 17;
    pts[i * 6] = f[o]; pts[i * 6 + 1] = f[o + 1]; pts[i * 6 + 2] = f[o + 2];
    const sh = 0.28209479177387814;
    pts[i * 6 + 3] = Math.min(1, Math.max(0, 0.5 + sh * f[o + 6]));
    pts[i * 6 + 4] = Math.min(1, Math.max(0, 0.5 + sh * f[o + 7]));
    pts[i * 6 + 5] = Math.min(1, Math.max(0, 0.5 + sh * f[o + 8]));
}

// 简易 PNG 编码器 (RGB, 无滤波)
function writePNG(path, w, h, rgb) {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crcTable = [];
        for (let c = 0; c < 256; c++) { let r = c; for (let k = 0; k < 8; k++) r = r & 1 ? 0xedb88320 ^ (r >>> 1) : r >>> 1; crcTable[c] = r >>> 0; }
        let crc = 0xffffffff;
        for (const byte of td) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        crc = (crc ^ 0xffffffff) >>> 0;
        const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc);
        return Buffer.concat([len, td, crcB]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 6 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
    writeFileSync(path, png);
}

// 投影渲染: 俯视 (X-Z) 与 侧视 (X-Y)
function render(proj, w, h, out, flipV = true) {
    // 统计范围
    let mn = [1e9, 1e9], mx = [-1e9, -1e9];
    for (let i = 0; i < n; i++) {
        const [u, v] = proj(i);
        if (u < mn[0]) mn[0] = u; if (u > mx[0]) mx[0] = u;
        if (v < mn[1]) mn[1] = v; if (v > mx[1]) mx[1] = v;
    }
    const img = Buffer.alloc(w * h * 3, 255);
    // 深度缓冲不做了, 直接叠加 (先暗后亮无所谓, 看结构)
    for (let i = 0; i < n; i++) {
        const [u, v] = proj(i);
        const px = Math.floor((u - mn[0]) / (mx[0] - mn[0]) * (w - 1));
        let py = Math.floor((v - mn[1]) / (mx[1] - mn[1]) * (h - 1));
        if (flipV) py = h - 1 - py;
        const o4 = (py * w + px) * 3;
        img[o4] = Math.round(pts[i * 6 + 3] * 255);
        img[o4 + 1] = Math.round(pts[i * 6 + 4] * 255);
        img[o4 + 2] = Math.round(pts[i * 6 + 5] * 255);
    }
    writePNG(out, w, h, img);
    console.log('[preview]', out, `u:[${mn[0].toFixed(1)},${mx[0].toFixed(1)}] v:[${mn[1].toFixed(1)},${mx[1].toFixed(1)}]`);
}

render((i) => [pts[i * 6], pts[i * 6 + 2]], 1000, 380, prefix + '_top.png');      // 俯视: x-z
render((i) => [pts[i * 6], pts[i * 6 + 1]], 1000, 380, prefix + '_side.png');     // 侧视: x-y
render((i) => [pts[i * 6 + 2], pts[i * 6 + 1]], 380, 500, prefix + '_front.png'); // 正视: z-y
