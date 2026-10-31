// Name validation shared by every storage backend.
exports.safeName = (s) => {
  s = String(s || '').trim();
  if (!s || s.startsWith('.') || /[\\/:*?"<>|\0]/.test(s) || s.length > 100) return null;
  return s;
};
exports.MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };
exports.byNum = (a, b) => a.localeCompare(b, undefined, { numeric: true });
