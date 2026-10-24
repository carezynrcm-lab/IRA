import './tz.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
// Local development server: same API/OAuth handler as Vercel, plus static files.
try { process.loadEnvFile(path.resolve(import.meta.dirname, '..', '.env')); } catch { /* no .env file */ }
const { handle } = await import('./app.js');
const { db } = await import('./db.js');
const { kick } = await import('./jobs.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
const gzip = promisify(zlib.gzip);

kick(db()); // pick up anything left in the queue

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// Static files are tiny, so keep them (and their gzipped form) in memory.
const fileCache = new Map();
async function loadStatic(rel) {
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return null;
  const stat = await fs.stat(full).catch(() => null);
  if (!stat?.isFile()) return null;
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  const hit = fileCache.get(full);
  if (hit?.etag === etag) return hit;
  const body = await fs.readFile(full);
  const entry = { etag, body, gz: await gzip(body), type: TYPES[path.extname(full)] || 'application/octet-stream' };
  fileCache.set(full, entry);
  return entry;
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = await loadStatic(rel);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const headers = { 'Content-Type': file.type, ETag: file.etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': file.gz.length });
    return res.end(file.gz);
  }
  res.writeHead(200, { ...headers, 'Content-Length': file.body.length });
  res.end(file.body);
}

const server = http.createServer(async (req, res) => {
  try {
    if ((await handle(req, res)) !== false) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    await serveStatic(req, res, new URL(req.url, 'http://localhost'));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, () => console.log(`IRA running at http://localhost:${PORT}`));

async function shutdown() {
  server.close();
  await db().end({ timeout: 2 });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
