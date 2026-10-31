// Notes server — zero dependencies. Run: node server.js
// Storage: local folder by default, Google Drive when GOOGLE_REFRESH_TOKEN is set (see storage/index.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { safeName, MIME } = require('./storage/common');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PASSWORD = process.env.NOTES_PASSWORD || '';
const store = require('./storage')();

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + (type.startsWith('text') || type.includes('json') ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 20e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function authed(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return pass === PASSWORD;
}

http.createServer(async (req, res) => {
  try {
    if (!authed(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Notes"' });
      return res.end('Authentication required');
    }
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const sp = (k) => url.searchParams.get(k);

    // --- API ---
    if (p === '/api/tree' && req.method === 'GET') return send(res, 200, await store.tree());

    if (p === '/api/note') {
      const d = safeName(sp('device')), t = safeName(sp('topic'));
      if (!d || !t) return send(res, 400, { error: 'bad name' });
      if (req.method === 'GET') {
        const buf = await store.get(d, t);
        return buf ? send(res, 200, buf, 'text/html') : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const html = await readBody(req);
        if (!html.trim()) return send(res, 400, { error: 'empty' });
        await store.put(d, t, html);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        return (await store.del(d, t)) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' });
      }
    }

    if (p === '/api/device' && req.method === 'POST') {
      if (!safeName(sp('name'))) return send(res, 400, { error: 'bad name' });
      await store.mkdevice(sp('name'));
      return send(res, 200, { ok: true });
    }

    // Raw note for the iframe (also serves images/css that sit next to the notes)
    if (p.startsWith('/raw/')) {
      const [, , d, t] = p.split('/');
      if (!t) return send(res, 404, 'not found', 'text/plain');
      const buf = t.toLowerCase().endsWith('.html') ? await store.get(d, t.slice(0, -5)) : null;
      if (buf) return send(res, 200, buf, 'text/html');
      const a = await store.asset(d, t);
      if (a) return send(res, 200, a.buf, a.type);
      return send(res, 404, 'not found', 'text/plain');
    }

    // --- static UI ---
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.resolve(PUBLIC_DIR, rel);
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile())
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`Notes running at http://localhost:${PORT}\n  storage: ${store.label}\n  ${PASSWORD ? 'password protected' : 'NO PASSWORD (set NOTES_PASSWORD before hosting online)'}`));
