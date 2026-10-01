#!/usr/bin/env node
// ============ 3DGS PLY 场景旋转工具 ============
// 绕 X 轴旋转整个场景 (位置 + 四元数一致旋转), 就地覆盖
// 用法: node tools/rotate-ply.mjs <角度> [ply路径]
//   例: node tools/rotate-ply.mjs -90        (从 -X 端看向 +X 时顺时针 90°)
// 数学: 位置 p' = R·p (全角); 朝向 q' = r ⊗ q (世界系前乘, r 为半角四元数)
// 注意: 仅支持 SH 0 阶场景 (无 f_rest); 高阶 SH 不随旋转, 会有视角颜色误差
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const deg = parseFloat(process.argv[2] ?? '90');
const plyPath = process.argv[3] || join(dir, '..', 'assets', 'scene.ply');
if (Number.isNaN(deg)) { console.error('用法: node tools/rotate-ply.mjs <角度> [ply路径]'); process.exit(1); }

const b = readFileSync(plyPath);
const headerEnd = b.indexOf('end_header\n') + 11;
const header = b.toString('ascii', 0, headerEnd);
const numPoints = +header.match(/element vertex (\d+)/)[1];
const props = (header.match(/property \w+ \w+/g) || []).map((l) => l.split(/\s+/)[2]);
const off = Object.fromEntries(props.map((p, i) => [p, i]));
for (const need of ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
    if (!(need in off)) { console.error(`缺少属性 ${need}, 不是标准 3DGS PLY`); process.exit(1); }
}
const strideBytes = props.length * 4;

// DataView 任意字节偏移可读写 (header 长度不保证 4 对齐)
const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
const fAt = (name) => off[name] * 4; // 属性在点内的字节偏移 (点起始地址由 o 提供)

// 旋转四元数 r (绕 X 轴, 半角) 与位置旋转系数
const t = (deg * Math.PI) / 180;
const c = Math.cos(t), s = Math.sin(t);
const rw = Math.cos(t / 2), rx = Math.sin(t / 2);
const quatMul = (a, bq) => [ // Hamilton 积 a ⊗ bq, (w,x,y,z)
    a[0] * bq[0] - a[1] * bq[1] - a[2] * bq[2] - a[3] * bq[3],
    a[0] * bq[1] + a[1] * bq[0] + a[2] * bq[3] - a[3] * bq[2],
    a[0] * bq[2] - a[1] * bq[3] + a[2] * bq[0] + a[3] * bq[1],
    a[0] * bq[3] + a[1] * bq[2] - a[2] * bq[1] + a[3] * bq[0],
];

let qmin = 1e9, qmax = 0;
for (let i = 0; i < numPoints; i++) {
    const o = headerEnd + i * strideBytes;
    // 位置
    const y = dv.getFloat32(o + fAt('y'), true);
    const z = dv.getFloat32(o + fAt('z'), true);
    dv.setFloat32(o + fAt('y'), y * c - z * s, true);
    dv.setFloat32(o + fAt('z'), y * s + z * c, true);
    // 朝向: q' = r ⊗ q
    const q = [
        dv.getFloat32(o + fAt('rot_0'), true),
        dv.getFloat32(o + fAt('rot_1'), true),
        dv.getFloat32(o + fAt('rot_2'), true),
        dv.getFloat32(o + fAt('rot_3'), true),
    ];
    const rq = quatMul([rw, rx, 0, 0], q);
    dv.setFloat32(o + fAt('rot_0'), rq[0], true);
    dv.setFloat32(o + fAt('rot_1'), rq[1], true);
    dv.setFloat32(o + fAt('rot_2'), rq[2], true);
    dv.setFloat32(o + fAt('rot_3'), rq[3], true);
    const qn = Math.hypot(rq[0], rq[1], rq[2], rq[3]);
    if (qn < qmin) qmin = qn; if (qn > qmax) qmax = qn;
}

writeFileSync(plyPath, b);
console.log(`[rotate-ply] ✔ 绕 X 轴旋转 ${deg}° 完成 (${numPoints} 点) → ${plyPath}`);
console.log(`[rotate-ply] 四元数模长 ${qmin.toFixed(4)} ~ ${qmax.toFixed(4)} (应≈1.0)`);
