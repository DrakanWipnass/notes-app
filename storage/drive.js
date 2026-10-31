// Notes in Google Drive. Zero dependencies (uses fetch). Layout inside Drive:
//   <ROOT folder>/<Device>/<Topic>.html
// Uses the narrow "drive.file" scope: the app only sees files/folders it created itself.
// Drive keeps its own version history of each file, and deleted notes go to the Drive trash.
const path = require('path');
const { safeName, MIME, byNum } = require('./common');

const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

module.exports = function drive({ clientId, clientSecret, refreshToken, rootName = 'F29-Notes', rootId = '' }) {
  let tok = { v: null, exp: 0 };
  async function token() {
    if (tok.v && Date.now() < tok.exp - 60000) return tok.v;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Google auth failed: ' + (j.error_description || j.error));
    tok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return tok.v;
  }
  async function g(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + (await token()), ...opts.headers } });
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r;
  }
  async function list(q) {
    const out = [];
    let pageToken = '';
    do {
      const p = { q, fields: 'nextPageToken,files(id,name,mimeType)', pageSize: '1000' };
      if (pageToken) p.pageToken = pageToken;
      const j = await (await g(`${API}/files?` + new URLSearchParams(p))).json();
      out.push(...j.files);
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  async function createFolder(name, parent) {
    const body = { name, mimeType: FOLDER };
    if (parent) body.parents = [parent];
    const r = await g(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()).id;
  }

  let rootP = null;
  const root = () => rootP || (rootP = (async () => {
    if (rootId) return rootId;
    const f = await list(`name='${esc(rootName)}' and mimeType='${FOLDER}' and trashed=false`);
    return f.length ? f[0].id : createFolder(rootName);
  })().catch((e) => { rootP = null; throw e; }));

  // cached index: Map device -> { id, files: Map name -> {id, mime} }
  let idx = null, idxAt = 0;
  async function index() {
    if (idx && Date.now() - idxAt < 15000) return idx;
    const rid = await root();
    const dirs = (await list(`'${rid}' in parents and mimeType='${FOLDER}' and trashed=false`)).filter((d) => !d.name.startsWith('.'));
    const m = new Map();
    await Promise.all(dirs.map(async (d) => {
      const files = await list(`'${d.id}' in parents and mimeType!='${FOLDER}' and trashed=false`);
      m.set(d.name, { id: d.id, files: new Map(files.map((f) => [f.name, { id: f.id, mime: f.mimeType }])) });
    }));
    idx = m; idxAt = Date.now();
    return m;
  }
  const dirty = () => { idxAt = 0; };

  function multipart(meta, html) {
    const b = 'b' + Math.random().toString(36).slice(2);
    return {
      type: `multipart/related; boundary=${b}`,
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${b}--`,
    };
  }
  const download = async (id) => Buffer.from(await (await g(`${API}/files/${id}?alt=media`)).arrayBuffer());

  return {
    label: `Google Drive folder "${rootName}"`,
    async tree() {
      const m = await index();
      return [...m].map(([device, d]) => ({
        device,
        topics: [...d.files.keys()].filter((n) => n.toLowerCase().endsWith('.html')).map((n) => n.slice(0, -5)).sort(byNum),
      })).sort((a, b) => byNum(a.device, b.device));
    },
    async get(d, t) {
      d = safeName(d); t = safeName(t); if (!d || !t) return null;
      const f = (await index()).get(d)?.files.get(t + '.html');
      return f ? download(f.id) : null;
    },
    async put(d, t, html) {
      d = safeName(d); t = safeName(t); if (!d || !t) throw new Error('bad name');
      const dev = (await index()).get(d) || { id: await createFolder(d, await root()), files: new Map() };
      const ex = dev.files.get(t + '.html');
      if (ex) {
        await g(`${UP}/files/${ex.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: html });
      } else {
        const mp = multipart({ name: t + '.html', parents: [dev.id], mimeType: 'text/html' }, html);
        await g(`${UP}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
      }
      dirty();
    },
    async del(d, t) {
      d = safeName(d); t = safeName(t); if (!d || !t) return false;
      const f = (await index()).get(d)?.files.get(t + '.html');
      if (!f) return false;
      await g(`${API}/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      dirty();
      return true;
    },
    async mkdevice(d) {
      d = safeName(d); if (!d) throw new Error('bad name');
      if ((await index()).has(d)) return;
      await createFolder(d, await root());
      dirty();
    },
    async asset(d, name) {
      d = safeName(d); name = safeName(name); if (!d || !name) return null;
      const f = (await index()).get(d)?.files.get(name);
      if (!f) return null;
      return { buf: await download(f.id), type: MIME[path.extname(name).toLowerCase()] || f.mime };
    },
  };
};
