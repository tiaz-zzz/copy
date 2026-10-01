# Arrival.Space 风格 3D 高斯泼溅查看器

复刻 [arrival.space/64122763_2334](https://arrival.space/64122763_2334) 页面的完整项目：
Arrival 风格的 UI（介绍层 / 场景内 HUD / 右侧抽屉菜单）+ 自己实现的高斯泼溅（3DGS）渲染查看器，
加载你提供的 `.spz` 泼溅文件。

## 运行

```bash
node server.js        # 默认 http://localhost:8080
# 或指定端口: node server.js 3000
```

浏览器打开 <http://localhost:8080> 即可。必须通过 HTTP 访问（直接双击 index.html 会因
file:// 跨域无法加载泼溅数据）。

## 项目结构

```
index.html            页面结构（splash / 介绍层 / 场景 HUD / 抽屉菜单 / 搜索浮层）
css/style.css         全部样式
js/main.js            查看器逻辑 + UI 交互（构建前源码）
dist/bundle.js        esbuild 打包产物（three.js + @mkkellogg/gaussian-splats-3d + main.js）
assets/scene.spz      原始高斯泼溅文件（你提供的 .spz）
assets/scene.ply      由 spz 解码出的标准 3DGS PLY（查看器实际加载的文件）
assets/scene-meta.json 场景统计 + 初始相机参数（可手动微调 position/target）
assets/*.webp|png|... 页面素材（Arrival 标志、作者头像、场景缩略图等，来自原页面公开资源）
tools/spz2ply.mjs     SPZ → PLY 解码/转换脚本（Node 零依赖）
tools/preview-ply.mjs 离线点云投影预览（不依赖 GPU，用于检查数据）
server.js             零依赖静态服务器
```

## 换一个 .spz 场景

```bash
# 1. 覆盖 assets/scene.spz
# 2. 重新转换
node tools/spz2ply.mjs 路径/到/新文件.spz assets/scene.ply assets/scene-meta.json
# 3. 视需要手动编辑 assets/scene-meta.json 里的 camera.position / camera.target
```

转换脚本按 Niantic 开放的 SPZ 格式规范实现（参考
[nianticlabs/spz](https://github.com/nianticlabs/spz)，MIT License），
支持 gzip 单流的 v1/v2/v3：24 位定点小数坐标、sigmoid 透明度、
对数尺度、v3 smallest-three 四元数、SH 高阶系数。

## 操作

- 鼠标左键拖动环顾四周，滚轮缩放
- `W A S D` / 方向键移动，`Shift` 加速
- 右上 ☰ 菜单 / 搜索；右侧点赞、评论、收藏、分享（本地交互演示）
- 左下提示卡可关闭（记忆在 localStorage）

## 技术说明

- 渲染：three.js r170 + [@mkkellogg/gaussian-splats-3d](https://github.com/mkkellogg/GaussianSplats3d)（WebGL2，Web Worker 排序）
- 打包：`npx esbuild js/main.js --bundle --outfile=dist/bundle.js --minify --platform=browser`
- 页面 UI（布局、文案、配色）为对照 arrival.space 实际界面重新实现的原创代码；
  场景元数据（标题、作者、描述）取自该页面的公开 meta 标签
