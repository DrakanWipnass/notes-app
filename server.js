// Notebook server — local-first markdown vault. Zero runtime dependencies (front-end libs are vendored from node_modules).
//   node server.js                 -> vault in ./vault, http://127.0.0.1:3001
//   VAULT_DIR=D:\notes PORT=4000    -> custom vault / port
// The vault is a plain folder of .md files (+ attachments). GitHub sync = the vault folder is a git repo (see lib/git.js).
// Hosting (e.g. Render): set NOTES_PASSWORD (required), GITHUB_REPO=owner/notes and GITHUB_TOKEN (repo write access).
//   The vault is cloned from GitHub on start and every change is committed + pushed back (AUTO_SYNC_SECONDS, default 20).
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const git = require('./lib/git');
const { seedVault } = require('./lib/sample-vault');

const ENV = process.env;
const PORT = Number(ENV.PORT) || 3001;
const HOST = ENV.HOST || (ENV.RENDER ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_BIND = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const PASSWORD = ENV.NOTES_PASSWORD || '';
// commit + push automatically after edits (on by default when the vault comes from GITHUB_REPO, e.g. on Render)
const AUTO_SYNC_MS = 1000 * Number(ENV.AUTO_SYNC_SECONDS ?? (ENV.GITHUB_REPO ? 20 : 0));
const VAULT = path.resolve(process.env.VAULT_DIR || path.join(__dirname, 'vault'));
const PUBLIC = path.join(__dirname, 'public');
const NM = path.join(__dirname, 'node_modules');
const IGNORE = new Set(['.git', '.trash', 'node_modules', '.DS_Store']);

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};
const TEXT_EXT = new Set(['.md', '.txt', '.html', '.htm', '.css', '.js', '.json', '.svg', '.csv', '.yml', '.yaml']);

// Vendored browser libraries: URL /vendor/<key>/... -> node_modules/<dir>/...
const VENDOR = {
  codemirror: 'codemirror', 'markdown-it': 'markdown-it/dist', footnote: 'markdown-it-footnote/dist', katex: 'katex/dist',
  mermaid: 'mermaid/dist', hljs: '@highlightjs/cdn-assets', 'js-yaml': 'js-yaml/dist', lucide: 'lucide/dist/umd',
};

// ---------- helpers ----------
/** Resolve a vault-relative path safely (no escaping the vault). */
function vpath(rel) {
  if (typeof rel !== 'string') return null;
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').some((s) => s === '..' || s === '.git')) return null;
  const abs = path.resolve(VAULT, rel);
  return abs.startsWith(VAULT + path.sep) ? abs : null;
}
const toRel = (abs) => path.relative(VAULT, abs).split(path.sep).join('/');

const send = (res, code, body, type = 'application/json') => {
  const textual = type.startsWith('text') || type.includes('json') || type.includes('svg');
  res.writeHead(code, { 'Content-Type': type + (textual ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req, limit = 50e6) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJSON = async (req) => JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');

async function walk(dir, out = []) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (IGNORE.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { out.push({ path: toRel(abs), type: 'folder' }); await walk(abs, out); }
    else if (e.isFile()) {
      const st = await fsp.stat(abs);
      out.push({ path: toRel(abs), type: 'file', size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs });
    }
  }
  return out;
}

// Writes we made ourselves — so the watcher doesn't echo them back to the client as "external" changes.
const recentWrites = new Map();
const markWrite = (rel) => recentWrites.set(rel, Date.now());

// ---------- link rewriting on rename (Obsidian-style [[wikilinks]] and ![[embeds]]) ----------
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function rewriteLinks(fromRel, toRel_) {
  const isMd = fromRel.toLowerCase().endsWith('.md');
  const strip = (p) => (isMd ? p.replace(/\.md$/i, '') : p);
  const oldBase = strip(path.posix.basename(fromRel)), newBase = strip(path.posix.basename(toRel_));
  const oldFull = strip(fromRel), newFull = strip(toRel_);
  // [[Old]] [[Old|alias]] [[Old#head]] [[folder/Old]]  — case-insensitive like Obsidian
  const re = new RegExp(`(!?\\[\\[)(${escapeRe(oldFull)}|${escapeRe(oldBase)})((?:\\.md)?)(?=[\\]|#^])`, 'gi');
  const changed = [];
  for (const f of await walk(VAULT)) {
    if (f.type !== 'file' || !f.path.toLowerCase().endsWith('.md')) continue;
    const abs = path.join(VAULT, f.path);
    const src = await fsp.readFile(abs, 'utf8');
    const out = src.replace(re, (m, open, name, ext) => open + (name.includes('/') ? newFull : newBase) + ext);
    if (out !== src) { markWrite(f.path); await fsp.writeFile(abs, out); changed.push(f.path); }
  }
  return changed;
}

// ---------- server-sent events: tell the browser when files change on disk (git pull, other editors) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
let pending = new Set(), flushTimer = null;
function startWatcher() {
  try {
    fs.watch(VAULT, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = name.split(path.sep).join('/');
      if (rel.split('/').some((s) => IGNORE.has(s))) return;
      const t = recentWrites.get(rel);
      if (t && Date.now() - t < 400) return; // the client also ignores events whose content it already has
      pending.add(rel);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { broadcast('change', { paths: [...pending] }); pending = new Set(); }, 300);
    });
  } catch (e) { console.warn('File watching unavailable:', e.message); }
}

// ---------- auth (HTTP Basic, like the previous app: any username, password = NOTES_PASSWORD) ----------
function authed(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

// ---------- server-side auto sync ----------
let autoTimer = null;
function scheduleAutoSync() {
  if (!AUTO_SYNC_MS) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    const r = await git.sync(VAULT);
    if (!r.ok) console.warn('auto-sync:', r.error);
    if ((r.log || []).some((l) => /Pulled/.test(l))) broadcast('change', { paths: ['*'] });
  }, AUTO_SYNC_MS);
}

// ---------- HTTP ----------
async function api(req, res, p, url) {
  const q = (k) => url.searchParams.get(k);
  const M = req.method;

  // Every mutating request must carry this header: it forces a CORS preflight, so random web pages
  // (and sandboxed html embeds) can't write to your vault through localhost.
  if (M !== 'GET' && req.headers['x-mdvault'] !== '1') return send(res, 403, { error: 'missing X-MDVault header' });
  if (M !== 'GET' && !p.startsWith('/api/git/')) res.on('finish', () => { if (res.statusCode < 300) scheduleAutoSync(); });

  if (p === '/api/files' && M === 'GET') return send(res, 200, { vault: VAULT, name: path.basename(VAULT), files: await walk(VAULT) });

  // all markdown contents in one go — the client keeps an in-memory index (links, backlinks, tags, search, graph)
  if (p === '/api/notes' && M === 'GET') {
    const out = {};
    for (const f of await walk(VAULT)) if (f.type === 'file' && f.path.toLowerCase().endsWith('.md')) out[f.path] = await fsp.readFile(path.join(VAULT, f.path), 'utf8');
    return send(res, 200, out);
  }

  if (p === '/api/file') {
    const abs = vpath(q('path'));
    if (!abs) return send(res, 400, { error: 'bad path' });
    const rel = toRel(abs);
    if (M === 'GET') {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'not found' });
      return send(res, 200, await fsp.readFile(abs), MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    }
    if (M === 'PUT') {
      const body = await readBody(req);
      if (q('create') === '1' && fs.existsSync(abs)) return send(res, 409, { error: 'already exists' });
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      markWrite(rel);
      await fsp.writeFile(abs, body);
      const st = await fsp.stat(abs);
      return send(res, 200, { ok: true, path: rel, mtime: st.mtimeMs });
    }
    if (M === 'DELETE') {
      if (!fs.existsSync(abs)) return send(res, 404, { error: 'not found' });
      // Like Obsidian: move to .trash inside the vault instead of hard-deleting
      const trash = path.join(VAULT, '.trash', `${Date.now()}-${path.basename(abs)}`);
      await fsp.mkdir(path.dirname(trash), { recursive: true });
      markWrite(rel);
      await fsp.rename(abs, trash);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/mkdir' && M === 'POST') {
    const abs = vpath((await readJSON(req)).path);
    if (!abs) return send(res, 400, { error: 'bad path' });
    await fsp.mkdir(abs, { recursive: true });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/rename' && M === 'POST') {
    const { from, to, updateLinks = true } = await readJSON(req);
    const a = vpath(from), b = vpath(to);
    if (!a || !b) return send(res, 400, { error: 'bad path' });
    if (!fs.existsSync(a)) return send(res, 404, { error: 'not found' });
    if (fs.existsSync(b) && a.toLowerCase() !== b.toLowerCase()) return send(res, 409, { error: 'target exists' });
    await fsp.mkdir(path.dirname(b), { recursive: true });
    markWrite(toRel(a)); markWrite(toRel(b));
    await fsp.rename(a, b);
    const changed = updateLinks && fs.statSync(b).isFile() ? await rewriteLinks(toRel(a), toRel(b)) : [];
    return send(res, 200, { ok: true, changed });
  }

  // ---- git / GitHub ----
  if (p === '/api/git/status' && M === 'GET') return send(res, 200, await git.status(VAULT));
  if (p === '/api/git/sync' && M === 'POST') {
    const { message } = await readJSON(req);
    const r = await git.sync(VAULT, message);
    broadcast('change', { paths: ['*'] });
    return send(res, 200, r);
  }
  if (p === '/api/git/setup' && M === 'POST') {
    const { remote, branch } = await readJSON(req);
    const r = await git.setup(VAULT, remote, branch);
    broadcast('change', { paths: ['*'] });
    return send(res, 200, r);
  }
  if (p === '/api/git/log' && M === 'GET') return send(res, 200, await git.log(VAULT, q('path')));

  if (p === '/api/events' && M === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  send(res, 404, { error: 'unknown api' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authed(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Notebook", charset="UTF-8"' });
      return res.end('Authentication required');
    }
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);

    if (p.startsWith('/api/')) return await api(req, res, p, url);

    // raw vault files: images, attachments, embedded .html diagrams  (/vault/attachments/x.png)
    if (p.startsWith('/vault/')) {
      const abs = vpath(p.slice(7));
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
        // vault html is never rendered at our origin (it could call the API); the client embeds it via sandboxed srcdoc
        return send(res, 200, await fsp.readFile(abs), type === 'text/html' ? 'text/plain' : type);
      }
      return send(res, 404, 'not found', 'text/plain');
    }

    if (p.startsWith('/vendor/')) {
      const [, , key, ...rest] = p.split('/');
      const base = VENDOR[key] && path.join(NM, VENDOR[key]);
      const file = base && path.resolve(base, rest.join('/'));
      if (file && file.startsWith(base) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.setHeader('Cache-Control', 'max-age=86400');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
      return send(res, 404, 'not found', 'text/plain');
    }

    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.resolve(PUBLIC, rel);
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile())
      return send(res, 200, await fsp.readFile(file), MIME[path.extname(file)] || 'application/octet-stream');
    // SPA fallback
    send(res, 200, await fsp.readFile(path.join(PUBLIC, 'index.html')), 'text/html');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

async function bootstrapFromGitHub() {
  const repo = ENV.GITHUB_REPO;
  if (!repo || fs.existsSync(path.join(VAULT, '.git'))) return false;
  const url = ENV.GITHUB_REMOTE_URL || `https://${ENV.GITHUB_TOKEN ? `x-access-token:${encodeURIComponent(ENV.GITHUB_TOKEN)}@` : ''}github.com/${repo}.git`;
  const empty = (await fsp.readdir(VAULT)).length === 0;
  if (empty) { console.log(`Cloning ${repo} into the vault...`); await git.clone(VAULT, url, ENV.GITHUB_BRANCH || ''); }
  else { const r = await git.setup(VAULT, url, ENV.GITHUB_BRANCH || ''); if (!r.ok) throw new Error(r.error); }
  return true;
}

(async () => {
  if (PUBLIC_BIND && !PASSWORD && ENV.ALLOW_NO_PASSWORD !== '1') {
    console.error(`Refusing to listen on ${HOST} without a password: anyone could read and edit your notes.\nSet NOTES_PASSWORD (or ALLOW_NO_PASSWORD=1 if something else protects the app).`);
    process.exit(1);
  }
  await fsp.mkdir(VAULT, { recursive: true });
  try {
    if (await bootstrapFromGitHub()) console.log('Vault cloned from GitHub.');
    else if (ENV.GITHUB_REPO) { const r = await git.sync(VAULT); if (!r.ok) console.warn('startup sync:', r.error); }
  } catch (e) { console.error('Could not get the vault from GitHub:', e.message); }
  await git.ensureIdentity(VAULT, ENV.GIT_AUTHOR_NAME || 'Notebook', ENV.GIT_AUTHOR_EMAIL || 'notebook@users.noreply.github.com');
  if ((await fsp.readdir(VAULT)).filter((n) => !n.startsWith('.')).length === 0 && !fs.existsSync(path.join(VAULT, '.git'))) {
    await seedVault(VAULT);
    console.log('Created a sample vault with a feature tour.');
  }
  startWatcher();
  server.listen(PORT, HOST, () => {
    console.log(`Notebook running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  vault: ${VAULT}`);
    console.log(`  ${PASSWORD ? 'password protected' : 'no password (local only)'}${AUTO_SYNC_MS ? ` - auto-sync to GitHub ${AUTO_SYNC_MS / 1000}s after edits` : ''}`);
  });
})();
