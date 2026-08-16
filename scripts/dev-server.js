#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// 月见开发服务器 — 单端口对外（默认 8080）
//   · 静态文件：serve 项目根目录（月见前端）
//   · 反向代理：EbbingFlow 路径（/v1 /monitor /ws 等）→ http://localhost:8000
// 这样月见与记忆后端/监视页同源，无需跨域、无需两个端口暴露给用户。
// 用法: node scripts/dev-server.js [端口]    默认 8080
// ═══════════════════════════════════════════════════════════
const http = require('http');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8080);
const ROOT = path.join(__dirname, '..');
const EBF_TARGET = 'http://localhost:8000';

// EbbingFlow 的 API/页面/ws 路径前缀 → 转发到后端
const PROXY_PREFIXES = [
  '/health', '/v1', '/api', '/monitor', '/ws',
  '/cdc', '/kb', '/maintenance', '/identity', '/evolution',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
};

const proxy = httpProxy.createProxyServer({ target: EBF_TARGET, ws: true, changeOrigin: true });
proxy.on('error', (err, req, res) => {
  console.error('[proxy]', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (res && !res.writableEnded) res.end('后端未启动（请先 docker compose up -d）');
});

function isProxy(pathname) {
  return PROXY_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
}

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
  if (isProxy(pathname)) proxy.web(req, res);
  else serveStatic(req, res, pathname);
});

// WebSocket 升级 → 转发到 EbbingFlow
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/ws')) proxy.ws(req, socket, head);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`月见开发服务器: http://localhost:${PORT}`);
  console.log(`  · 前端（月见）:  http://localhost:${PORT}/`);
  console.log(`  · 监视页（代理）: http://localhost:${PORT}/monitor`);
  console.log(`  · 后端代理目标:   ${EBF_TARGET}`);
});
