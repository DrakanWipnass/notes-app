// Notes on the local disk: <dir>/<Device>/<Topic>.html (+ timestamped backups in .history)
const fs = require('fs');
const path = require('path');
const { safeName, MIME, byNum } = require('./common');

module.exports = function local(dir, maxBackups = 20) {
  dir = path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true });
  const notePath = (d, t) => { d = safeName(d); t = safeName(t); return d && t ? path.join(dir, d, t + '.html') : null; };

  function backup(file) {
    if (!fs.existsSync(file)) return;
    const h = path.join(dir, '.history', path.basename(path.dirname(file)), path.basename(file, '.html'));
    fs.mkdirSync(h, { recursive: true });
    fs.copyFileSync(file, path.join(h, new Date().toISOString().replace(/[:.]/g, '-') + '.html'));
    const all = fs.readdirSync(h).sort();
    for (const old of all.slice(0, Math.max(0, all.length - maxBackups))) fs.unlinkSync(path.join(h, old));
  }

  return {
    label: `local folder ${dir}`,
    async tree() {
      const out = [];
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const topics = fs.readdirSync(path.join(dir, d.name)).filter((f) => f.toLowerCase().endsWith('.html')).map((f) => f.slice(0, -5)).sort(byNum);
        out.push({ device: d.name, topics });
      }
      return out.sort((a, b) => byNum(a.device, b.device));
    },
    async get(d, t) { const f = notePath(d, t); return f && fs.existsSync(f) ? fs.readFileSync(f) : null; },
    async put(d, t, html) {
      const f = notePath(d, t); if (!f) throw new Error('bad name');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      backup(f); fs.writeFileSync(f, html, 'utf8');
    },
    async del(d, t) {
      const f = notePath(d, t); if (!f || !fs.existsSync(f)) return false;
      backup(f); fs.unlinkSync(f); return true;
    },
    async mkdevice(d) { d = safeName(d); if (!d) throw new Error('bad name'); fs.mkdirSync(path.join(dir, d), { recursive: true }); },
    async asset(d, name) {
      d = safeName(d); name = safeName(name); if (!d || !name) return null;
      const f = path.join(dir, d, name);
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return null;
      return { buf: fs.readFileSync(f), type: MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' };
    },
  };
};
