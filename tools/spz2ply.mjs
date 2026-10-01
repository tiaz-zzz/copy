#!/usr/bin/env node
// ============ SPZ → PLY 转换器 ============
// 依据 Niantic SPZ 开放格式规范 (github.com/nianticlabs/spz, MIT License) 实现:
//   - gzip 单流 legacy 格式 (16 字节头, v1/v2/v3)
//   - positions: 24-bit 定点小数 (fractionalBits), v1 为 float16
//   - alphas:    uint8 = sigmoid(logit) * 255
//   - colors:    uint8 = (f_dc * SH_C0 + 0.5) * 255
//   - scales:    uint8 = (log(scale) + 10) * 16
//   - rotations: v2 = xyz 8bit 量化 (w 为正可推导); v3+ = smallest-three 10bit 字段
//   - sh:        uint8 = sh * 128 + 128
// 输出: 标准 3DGS 二进制 PLY (rot_0 = w) + scene-meta.json (包围盒/建议相机)

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SH_C0 = 0.28209479177387814;
const SQRT1_2 = Math.SQRT1_2;

// ---------- 参数 ----------
const args = process.argv.slice(2);
const inPath = args[0] || join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'scene.spz');
const outPly = args[1] || join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'scene.ply');
const outMeta = args[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'scene-meta.json');

// 可选场景旋转 (烘焙进数据):
//   --roll 角度   绕 X 轴旋转 (右手定则; 从 -X 端朝 +X 看时, 正角度为逆时针)
//   --yaw 角度    绕 Y 轴旋转 (俯视时逆时针)
// 注意: 本转换只对位置/四元数生效; 若场景带 1 阶以上 SH 系数, 高阶颜色不会跟着旋转
let rollDeg = 0, yawDeg = 0;
for (let i = 3; i < args.length; i++) {
    if (args[i] === '--roll') rollDeg = parseFloat(args[++i]) || 0;
    else if (args[i] === '--yaw') yawDeg = parseFloat(args[++i]) || 0;
}

// ---------- 读取 & 解压 ----------
const raw = readFileSync(inPath);
let data;
try {
    data = gunzipSync(raw);
} catch {
    data = raw; // 未压缩的 spz
}

const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

// ---------- 头部 ----------
const MAGIC = 0x5053474e; // "NGSP" (小端)
const magic = dv.getUint32(0, true);
if (magic !== MAGIC) {
    console.error(`[spz2ply] 魔数不匹配: 0x${magic.toString(16)} (期望 0x${MAGIC.toString(16)})`);
    process.exit(1);
}
const version = dv.getUint32(4, true);
const numPoints = dv.getUint32(8, true);
const shDegree = dv.getUint8(12);
const fractionalBits = dv.getUint8(13);
const flags = dv.getUint8(14);

if (version < 1 || version > 3) {
    console.error(`[spz2ply] 不支持的版本: ${version}`);
    process.exit(1);
}

// 文件中 SH 段的系数数/通道: 不含 DC 项 (DC 已编码在 colors 中)
// dimForDegree(0)=0, 否则 d*d+2*d  (1阶→3, 2阶→8, 3阶→15, 4阶→24)
const shDimFile = shDegree >= 1 ? shDegree * (shDegree + 2) : 0;
const usesFloat16 = version === 1;
const smallestThree = version >= 3;
const posBytes = usesFloat16 ? 6 : 9;
const rotBytes = smallestThree ? 4 : 3;

const offPos = 16;
const offAlpha = offPos + numPoints * posBytes;
const offColor = offAlpha + numPoints;
const offScale = offColor + numPoints * 3;
const offRot = offScale + numPoints * 3;
const offSh = offRot + numPoints * rotBytes;
const totalExpected = offSh + numPoints * shDimFile * 3;

console.log(`[spz2ply] version=${version} numPoints=${numPoints} shDegree=${shDegree} fractionalBits=${fractionalBits} flags=0x${flags.toString(16)}`);
console.log(`[spz2ply] 解压后 ${data.byteLength} 字节, 预期 ${totalExpected} 字节`);
if (data.byteLength < totalExpected) {
    console.error('[spz2ply] 文件不完整!');
    process.exit(1);
}

// ---------- 解码辅助 ----------
function readInt24(o) {
    let v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
    if (v & 0x800000) v |= ~0xffffff; // 符号扩展
    return v;
}
function readFloat16(o) {
    const h = data[o] | (data[o + 1] << 8);
    const s = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) return s * Math.pow(2, -14) * (frac / 1024);
    if (exp === 31) return s * (frac ? NaN : Infinity);
    return s * Math.pow(2, exp - 15) * (1 + frac / 1024);
}
const invSigmoid = (p) => {
    p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
    return Math.log(p / (1 - p));
};

// ---------- 场景旋转 ----------
// 四元数乘法 (w,x,y,z); rotQuat 把单位四元数 q 绕轴旋转 r: q' = r ⊗ q ⊗ r⁻¹
function quatMul(a, b) {
    return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
}
function axisAngleQuat(axis, deg) {
    const t = (deg * Math.PI) / 180;
    const s = Math.sin(t / 2);
    return [Math.cos(t / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}
function quatConj(q) { return [q[0], -q[1], -q[2], -q[3]]; }

// 组合出总旋转四元数 (先 roll 后 yaw 的等效顺序对单一轴无影响, 两轴都用时按 roll→yaw)
let ROT_Q = [1, 0, 0, 0]; // 单位四元数 (w,x,y,z)
let ROT_FN = null;
if (rollDeg !== 0 || yawDeg !== 0) {
    if (rollDeg !== 0) ROT_Q = quatMul(axisAngleQuat([1, 0, 0], rollDeg), ROT_Q);
    if (yawDeg !== 0) ROT_Q = quatMul(axisAngleQuat([0, 1, 0], yawDeg), ROT_Q);
    const ROT_Q_INV = quatConj(ROT_Q);
    ROT_FN = {
        point: (p) => {
            // 向量旋转: v' = r ⊗ (0,v) ⊗ r⁻¹
            const qv = [0, p[0], p[1], p[2]];
            const r1 = quatMul(ROT_Q, qv);
            const r2 = quatMul(r1, ROT_Q_INV);
            return [r2[1], r2[2], r2[3]];
        },
        quat: (q) => {
            const r1 = quatMul(ROT_Q, [q[0], q[1], q[2], q[3]]);
            const r2 = quatMul(r1, ROT_Q_INV);
            return [r2[0], r2[1], r2[2], r2[3]];
        },
    };
    if (shDegree >= 1) {
        console.warn('[spz2ply] 警告: 场景含 1 阶以上 SH 系数, 旋转只作用于位置/朝向, 视角相关颜色不会正确旋转!');
    }
    console.log(`[spz2ply] 应用场景旋转: roll=${rollDeg}° yaw=${yawDeg}°`);
}

// smallest-three 四元数: u32 = [iLargest:2][compA:10][compB:10][compC:10]
// 每个字段: bit9 = 符号(相对最大分量归正后), bit0-8 = round(511 * |q| / √½)
function unpackQuatSmallestThree(o) {
    const comp = dv.getUint32(o, true);
    const iLargest = comp >>> 30;
    const q = [0, 0, 0, 0];
    let sum2 = 0, idx = 0;
    for (let i = 0; i < 4; i++) {
        if (i === iLargest) continue;
        const field = (comp >>> (10 * (2 - idx))) & 0x3ff;
        idx++;
        const neg = (field >>> 9) & 1;
        const mag = field & 511;
        const v = (mag / 511) * SQRT1_2 * (neg ? -1 : 1);
        q[i] = v;
        sum2 += v * v;
    }
    q[iLargest] = Math.sqrt(Math.max(0, 1 - sum2));
    return q;
}
// v2 first-three: xyz 各 8bit, w 为正且由单位长度推导
function unpackQuatFirstThree(o) {
    const x = (data[o] - 127.5) / 127.5;
    const y = (data[o + 1] - 127.5) / 127.5;
    const z = (data[o + 2] - 127.5) / 127.5;
    const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    return [w, x, y, z]; // 返回 (w,x,y,z)
}

// ---------- 解码主循环 ----------
// PLY 每点字段: x y z nx ny nz f_dc0..2 f_rest0..(shDimFile*3-1) opacity scale0..2 rot0..3
const stride = 3 + 3 + 3 + shDimFile * 3 + 1 + 3 + 4;
const out = new ArrayBuffer(numPoints * stride * 4);
const fv = new Float32Array(out);

const buf = new Float32Array(stride);

const bboxMin = [Infinity, Infinity, Infinity];
const bboxMax = [-Infinity, -Infinity, -Infinity];

let p = 0;
for (let i = 0; i < numPoints; i++) {
    // 位置
    let x, y, z;
    if (usesFloat16) {
        x = readFloat16(offPos + i * 6);
        y = readFloat16(offPos + i * 6 + 2);
        z = readFloat16(offPos + i * 6 + 4);
    } else {
        const s = 1 / (1 << fractionalBits);
        x = readInt24(offPos + i * 9) * s;
        y = readInt24(offPos + i * 9 + 3) * s;
        z = readInt24(offPos + i * 9 + 6) * s;
    }
    if (ROT_FN) { [x, y, z] = ROT_FN.point([x, y, z]); }
    // alpha (logit)
    const opacity = invSigmoid(data[offAlpha + i] / 255);
    // 颜色 → SH DC 系数
    const fdc0 = (data[offColor + i * 3] / 255 - 0.5) / SH_C0;
    const fdc1 = (data[offColor + i * 3 + 1] / 255 - 0.5) / SH_C0;
    const fdc2 = (data[offColor + i * 3 + 2] / 255 - 0.5) / SH_C0;
    // 尺度 (log)
    const s0 = data[offScale + i * 3] / 16 - 10;
    const s1 = data[offScale + i * 3 + 1] / 16 - 10;
    const s2 = data[offScale + i * 3 + 2] / 16 - 10;
    // 旋转 (w,x,y,z)
    const q = smallestThree
        ? (() => { const [qx, qy, qz, qw] = unpackQuatSmallestThree(offRot + i * 4); return [qw, qx, qy, qz]; })()
        : unpackQuatFirstThree(offRot + i * 3);
    if (ROT_FN) {
        const rq = ROT_FN.quat(q);
        q[0] = rq[0]; q[1] = rq[1]; q[2] = rq[2]; q[3] = rq[3];
    }

    let k = 0;
    buf[k++] = x; buf[k++] = y; buf[k++] = z;
    buf[k++] = 0; buf[k++] = 0; buf[k++] = 0; // 法线占位
    buf[k++] = fdc0; buf[k++] = fdc1; buf[k++] = fdc2;
    // SH 高阶系数 (文件按 系数×通道 排列, 不含 DC; f_rest 顺序与 INRIA 一致)
    for (let c = 0; c < 3; c++) {
        for (let j = 0; j < shDimFile; j++) {
            buf[k++] = (data[offSh + i * shDimFile * 3 + j * 3 + c] - 128) / 128;
        }
    }
    buf[k++] = opacity;
    buf[k++] = s0; buf[k++] = s1; buf[k++] = s2;
    buf[k++] = q[0]; buf[k++] = q[1]; buf[k++] = q[2]; buf[k++] = q[3];

    fv.set(buf, i * stride);

    if (x < bboxMin[0]) bboxMin[0] = x; if (x > bboxMax[0]) bboxMax[0] = x;
    if (y < bboxMin[1]) bboxMin[1] = y; if (y > bboxMax[1]) bboxMax[1] = y;
    if (z < bboxMin[2]) bboxMin[2] = z; if (z > bboxMax[2]) bboxMax[2] = z;
    p++;
}

// ---------- 写 PLY ----------
const props = ['x', 'y', 'z', 'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: shDimFile * 3 }, (_, j) => `f_rest_${j}`),
    'opacity', 'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'comment Created by spz2ply (Niantic SPZ open-format converter)\n' +
    `element vertex ${numPoints}\n` +
    props.map((n) => `property float ${n}\n`).join('') +
    'end_header\n';

const headerBytes = Buffer.from(header, 'ascii');
const body = Buffer.from(out, 0, numPoints * stride * 4);
writeFileSync(outPly, Buffer.concat([headerBytes, body]));

// ---------- 建议初始相机 ----------
const center = bboxMin.map((m, i) => (m + bboxMax[i]) / 2);
const size = bboxMax.map((m, i) => m - bboxMin[i]);
const longAxis = size.indexOf(Math.max(...size));

const meta = {
    source: 'spz',
    version, numPoints, shDegree, fractionalBits,
    antialiased: (flags & 1) !== 0,
    bbox: { min: bboxMin, max: bboxMax, center, size },
    camera: {
        // 相机放在最长轴一端内部 (5% 处), 视线看向中心稍上方
        position: [
            +(center[0] - Math.sign(center[0] - bboxMin[0]) * (size[longAxis] / 2 - size[longAxis] * 0.04)).toFixed(3),
            +(center[1] + size[1] * 0.06).toFixed(3),
            +center[2].toFixed(3),
        ],
        target: [+center[0].toFixed(3), +(center[1] + size[1] * 0.10).toFixed(3), +center[2].toFixed(3)],
        up: [0, 1, 0],
    },
};
writeFileSync(outMeta, JSON.stringify(meta, null, 2));

console.log(`[spz2ply] ✔ 写出 ${outPly} (${numPoints} 点, SH ${shDegree} 阶)`);
console.log(`[spz2ply] 包围盒 min=(${bboxMin.map((v) => v.toFixed(2))}) max=(${bboxMax.map((v) => v.toFixed(2))})`);
console.log(`[spz2ply] 中心=(${center.map((v) => v.toFixed(2))}) 尺寸=(${size.map((v) => v.toFixed(2))})`);
