// Notes in a (private) GitHub repo. Zero dependencies (uses fetch).
//   repo layout:  <Device>/<Topic>.html   (optionally under a sub-folder, see GITHUB_PATH)
// Every save is a commit, so GitHub's history gives you diffs and rollback for free.
const path = require('path');
const { safeName, MIME, byNum } = require('./common');

module.exports = function github({ token, repo, branch = '', prefix = '', apiBase = 'https://api.github.com' }) {
  prefix = prefix.replace(/^\/+|\/+$/g, '');
  const full = (...parts) => [prefix, ...parts].filter(Boolean).join('/');
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function gh(url, opts = {}, okCodes = []) {
    const r = await fetch(apiBase + url, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'notes-app',
        ...opts.headers,
      },
    });
    if (!r.ok && !okCodes.includes(r.status)) {
      const t = (await r.text()).slice(0, 300);
      if (r.status === 401) throw new Error('GitHub: token rejected (expired or wrong). ' + t);
      if (r.status === 404) throw new Error(`GitHub: repo "${repo}" not found or token has no access. ` + t);
      throw new Error(`GitHub ${r.status}: ${t}`);
    }
    return r;
  }
  const refQ = branch ? `?ref=${encodeURIComponent(branch)}` : '';

  // cached listing of all file paths (one API call)
  let cache = null, cacheAt = 0;
  async function files() {
    if (cache && Date.now() - cacheAt < 15000) return cache;
    const r = await gh(`/repos/${repo}/git/trees/${encodeURIComponent(branch || 'HEAD')}?recursive=1`, {}, [404, 409]);
    let paths = [];
    if (r.ok) {
      const j = await r.json();
      paths = j.tree.filter((e) => e.type === 'blob').map((e) => e.path);
    } // 409 = empty repo, 404 = no branch yet -> treat as empty
    const base = prefix ? prefix + '/' : '';
    cache = paths.filter((p) => p.startsWith(base)).map((p) => p.slice(base.length));
    cacheAt = Date.now();
    return cache;
  }
  const dirty = () => { cacheAt = 0; };

  async function sha(p) {
    const r = await gh(`/repos/${repo}/contents/${enc(p)}${refQ}`, {}, [404]);
    return r.ok ? (await r.json()).sha : null;
  }
  async function write(p, buf, message) {
    const body = { message, content: Buffer.from(buf).toString('base64') };
    if (branch) body.branch = branch;
    const s = await sha(p);
    if (s) body.sha = s;
    await gh(`/repos/${repo}/contents/${enc(p)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    dirty();
  }
  async function read(p) {
    const r = await gh(`/repos/${repo}/contents/${enc(p)}${refQ}`, { headers: { Accept: 'application/vnd.github.raw+json' } }, [404]);
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  }

  return {
    label: `GitHub repo ${repo}${branch ? '@' + branch : ''}${prefix ? ' /' + prefix : ''}`,
    async tree() {
      const devices = new Map();
      for (const f of await files()) {
        const parts = f.split('/');
        if (parts.length !== 2 || parts[0].startsWith('.')) continue;
        if (!devices.has(parts[0])) devices.set(parts[0], []);
        if (parts[1].toLowerCase().endsWith('.html')) devices.get(parts[0]).push(parts[1].slice(0, -5));
      }
      return [...devices].map(([device, topics]) => ({ device, topics: topics.sort(byNum) })).sort((a, b) => byNum(a.device, b.device));
    },
    async get(d, t) {
      d = safeName(d); t = safeName(t); if (!d || !t) return null;
      return read(full(d, t + '.html'));
    },
    async put(d, t, html) {
      d = safeName(d); t = safeName(t); if (!d || !t) throw new Error('bad name');
      await write(full(d, t + '.html'), html, `Update ${d}/${t}`);
    },
    async del(d, t) {
      d = safeName(d); t = safeName(t); if (!d || !t) return false;
      const p = full(d, t + '.html');
      const s = await sha(p);
      if (!s) return false;
      const body = { message: `Delete ${d}/${t}`, sha: s };
      if (branch) body.branch = branch;
      await gh(`/repos/${repo}/contents/${enc(p)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      dirty();
      return true;
    },
    async mkdevice(d) {
      d = safeName(d); if (!d) throw new Error('bad name');
      // git has no empty folders, so drop a placeholder file
      if (!(await files()).some((f) => f.startsWith(d + '/'))) await write(full(d, '.gitkeep'), '', `Add device ${d}`);
    },
    async asset(d, name) {
      d = safeName(d); name = safeName(name); if (!d || !name) return null;
      const buf = await read(full(d, name));
      return buf ? { buf, type: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' } : null;
    },
  };
};
