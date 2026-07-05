// Cutout — tiny zero-dependency static server.
// Serves ./public. The background-removal AI runs entirely in the browser,
// so this server never sees or stores any user images.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8092;
const ROOT = path.join(__dirname, 'public');

// --- Persistent "images processed" counter -------------------------------
// The AI runs in the browser; the client pings us after each successful
// removal so we can keep a global tally. We store only a number — never images.
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
let processed = 0;
try { processed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).processed || 0; } catch {}
let saveTimer = null;
function saveStats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      fs.writeFile(STATS_FILE, JSON.stringify({ processed }), () => {});
    });
  }, 500); // debounce disk writes
}
function sendJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // Stats API.
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/stats') {
    return sendJSON(res, { processed });
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/processed') {
    // Drain (and ignore) any body, then increment.
    req.on('data', () => {});
    req.on('end', () => {
      processed += 1;
      saveStats();
      sendJSON(res, { processed });
    });
    return;
  }

  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Prevent path traversal.
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
    });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Cutout serving on :${PORT}`));
