// serve.mjs — tiny static file server for local development & screenshots.
// Usage: node serve.mjs   ->   http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const data = await readFile(filePath);
    const type = TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    // Honour Range requests, as GitHub Pages does. The app's sync uses a ranged
    // GET to read just the backup file's `meta` header instead of pulling the
    // whole multi-MB file on every poll, so the dev server has to behave the
    // same way or local testing would exercise a different code path.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] === '' ? 0 : Number(range[1]);
      const end = range[2] === '' ? data.length - 1 : Math.min(Number(range[2]), data.length - 1);
      if (start <= end && start < data.length) {
        const slice = data.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': type, 'Cache-Control': 'no-cache',
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': slice.length, 'Accept-Ranges': 'bytes',
        });
        return res.end(slice);
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`Frendz Front Desk → http://localhost:${PORT}`));
