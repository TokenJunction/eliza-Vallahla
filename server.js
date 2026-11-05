const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.existsSync(path.join(__dirname, 'site-build', 'index.html'))
  ? path.join(__dirname, 'site-build')
  : __dirname;
const port = Number(process.env.PORT) || 10000;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
};
const hidden = /(^|[\\/])(\.|node_modules|workers|supabase|scripts|valhalla-elizaos)/;

function resolve(urlPath) {
  const rel = path.normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^([\\/]|\.\.)+/, '');
  if (hidden.test(rel)) return null;
  let file = path.join(root, rel);
  if (!file.startsWith(root)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let file;
  try { file = resolve(req.url); } catch { file = null; }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`Valhalla serving ${root} on :${port}`));
