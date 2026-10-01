#!/usr/bin/env node
// ============ 零依赖静态文件服务器 ============
// 用法: node server.js [端口]   (默认 8080)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ply': 'application/octet-stream',
    '.splat': 'application/octet-stream',
    '.spz': 'application/octet-stream',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
    try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let filePath = path.normalize(path.join(ROOT, urlPath));
        if (!filePath.startsWith(ROOT)) {
            res.writeHead(403); res.end('Forbidden'); return;
        }
        if (urlPath === '/' || urlPath === '') filePath = path.join(ROOT, 'index.html');

        fs.stat(filePath, (err, st) => {
            if (err || !st.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('404 Not Found');
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                'Content-Length': st.size,
                'Cache-Control': 'no-cache',
                'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(filePath).pipe(res);
        });
    } catch (e) {
        res.writeHead(500); res.end('Internal Error');
    }
});

server.listen(PORT, () => {
    console.log(`✓ Arrival 复刻查看器已启动: http://localhost:${PORT}`);
});
