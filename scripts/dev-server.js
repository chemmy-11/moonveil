#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// 月见开发服务器 — 纯静态文件服务（默认 8080）
//   · serve 项目根目录（月见前端）
//   · （原 EbbingFlow 反代层已随该后端移除，issue #33）
// 用法: node scripts/dev-server.js [端口]    默认 8080
// ═══════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8080);
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`月见开发服务器: http://localhost:${PORT}`);
  console.log(`  · 前端（月见）:  http://localhost:${PORT}/`);
});
