// Thin client for the local server. Mutations carry X-MDVault so the server can reject cross-site requests.
const H = { 'X-MDVault': '1' };
async function check(r) {
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r;
}
const enc = encodeURIComponent;

export const api = {
  files: () => fetch('/api/files').then(check).then((r) => r.json()),
  notes: () => fetch('/api/notes').then(check).then((r) => r.json()),
  read: (path) => fetch('/api/file?path=' + enc(path)).then(check).then((r) => r.text()),
  write: (path, body, { create = false } = {}) =>
    fetch(`/api/file?path=${enc(path)}${create ? '&create=1' : ''}`, { method: 'PUT', headers: H, body }).then(check).then((r) => r.json()),
  remove: (path) => fetch('/api/file?path=' + enc(path), { method: 'DELETE', headers: H }).then(check).then((r) => r.json()),
  mkdir: (path) => post('/api/mkdir', { path }),
  rename: (from, to, updateLinks = true) => post('/api/rename', { from, to, updateLinks }),
  gitStatus: () => fetch('/api/git/status').then(check).then((r) => r.json()),
  gitSync: (message) => post('/api/git/sync', { message }),
  gitSetup: (remote, branch) => post('/api/git/setup', { remote, branch }),
  gitLog: (path) => fetch('/api/git/log' + (path ? '?path=' + enc(path) : '')).then(check).then((r) => r.json()),
};
function post(url, data) {
  return fetch(url, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(check).then((r) => r.json());
}
export const rawUrl = (path) => '/vault/' + path.split('/').map(enc).join('/');
