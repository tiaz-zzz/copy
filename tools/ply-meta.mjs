#!/usr/bin/env node
// ============ 3DGS 二进制 PLY 元数据工具 ============
// 读取标准 3DGS PLY, 计算包围盒 / 检测地板高度, 生成 scene-meta.json (初始相机)
// 用法: node tools/ply-meta.mjs [in.ply] [out-meta.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const inPath = process.argv[2] || join(dir, '..', 'assets', 'scene.ply');
const outPath = process.argv[3] || join(dir, '..', 'assets', 'scene-meta.json');

const b = readFileSync(inPath);
const headerEnd = b.indexOf('end_header\n') + 11;
const header = b.toString('ascii', 0, headerEnd);

const numPoints = +header.match(/element vertex (\d+)/)[1];
const props = (header.match(/property \w+ \w+/g) || []).map((l) => l.split(/\s+/)[2]);
const isBinary = header.includes('binary_little_endian');
if (!isBinary) { console.error('仅支持 binary_little_endian PLY'); process.exit(1); }

// 每点字节数: 按属性类型累加 (当前 3DGS PLY 均为 float32)
const FLOATS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'nx', 'ny', 'nz', ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`)];
let strideFloats = 0;
for (const p of props) strideFloats += FLOATS.includes(p) ? 1 : 0;
const hasNormals = props.includes('nx');
const shRestCount = props.filter((p) => p.startsWith('f_rest_')).length;
const shDegree = shRestCount >= 45 ? 3 : shRestCount >= 24 ? 2 : shRestCount >= 9 ? 1 : 0;

const body = b.subarray(headerEnd);
const f = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
const n = f.length / strideFloats;
if (n !== numPoints) { console.error(`点数不符: 头 ${numPoints} vs 体 ${n}`); process.exit(1); }

// 包围盒 (全点) + 地板检测 (不透明点的 y 5% 分位)
const idx = Object.fromEntries(props.map((p, i) => [p, i]));
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
const ys = [];
for (let i = 0; i < n; i++) {
    const o = i * strideFloats;
    for (let a = 0; a < 3; a++) {
        const v = f[o + a];
        if (v < mn[a]) mn[a] = v;
        if (v > mx[a]) mx[a] = v;
    }
    if (1 / (1 + Math.exp(-f[o + idx.opacity])) > 0.5) ys.push(f[o + 1]);
}
ys.sort((a, b2) => a - b2);
const floorY = ys.length > 100 ? ys[Math.floor(ys.length * 0.05)] : null;

const center = mn.map((m, i) => (m + mx[i]) / 2);
const size = mx.map((m, i) => m - mn[i]);
const longAxis = size.indexOf(Math.max(...size));

// 初始相机: 沿最长轴、包围盒内部一端 (4% 处); 高度优先用地板 + 1.6m 眼高
const useFloor = floorY !== null && floorY > mn[1] && floorY < center[1];
const eyeY = useFloor ? floorY + 1.6 : center[1] + size[1] * 0.06;
const lookY = useFloor ? floorY + 1.9 : center[1] + size[1] * 0.10;

const position = [center[0], eyeY, center[2]];
const target = [center[0], lookY, center[2]];
position[longAxis] = mn[longAxis] + size[longAxis] * 0.04;

const meta = {
    source: 'ply',
    numPoints,
    shDegree,
    hasNormals,
    floorY: useFloor ? +floorY.toFixed(3) : null,
    bbox: {
        min: mn.map((v) => +v.toFixed(3)),
        max: mx.map((v) => +v.toFixed(3)),
        center: center.map((v) => +v.toFixed(3)),
        size: size.map((v) => +v.toFixed(3)),
    },
    camera: {
        position: position.map((v) => +v.toFixed(3)),
        target: target.map((v) => +v.toFixed(3)),
        up: [0, 1, 0],
    },
};
writeFileSync(outPath, JSON.stringify(meta, null, 2));

console.log(`[ply-meta] 点数=${numPoints} SH=${shDegree}阶 每点${strideFloats}float`);
console.log(`[ply-meta] 包围盒 min=(${mn.map((v) => v.toFixed(2))}) max=(${mx.map((v) => v.toFixed(2))})`);
console.log(`[ply-meta] 地板 y≈${floorY === null ? '未检出' : floorY.toFixed(2)} → 眼高 ${eyeY.toFixed(2)}`);
console.log(`[ply-meta] 初始相机 position=(${position.map((v) => v.toFixed(2))}) target=(${target.map((v) => v.toFixed(2))})`);
console.log(`[ply-meta] ✔ 写出 ${outPath}`);
