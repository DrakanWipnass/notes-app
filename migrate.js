// Uploads everything in ./notes to the configured remote storage (GitHub repo or Google Drive).
// Usage:  node migrate.js [local-notes-dir]
// GitHub: set GITHUB_TOKEN and GITHUB_REPO.   Drive: set the GOOGLE_* variables.
// Notes with the same name in the remote are overwritten (their old versions stay in its history).
const fs = require('fs');
const path = require('path');

if (!process.env.GITHUB_TOKEN && !process.env.GOOGLE_REFRESH_TOKEN) {
  console.error('Set GITHUB_TOKEN and GITHUB_REPO (or the GOOGLE_* variables) first.');
  process.exit(1);
}
const src = path.resolve(process.argv[2] || path.join(__dirname, 'notes'));
const remote = require('./storage')();

(async () => {
  console.log(`Uploading ${src}  ->  ${remote.label}`);
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    for (const f of fs.readdirSync(path.join(src, d.name))) {
      if (!f.toLowerCase().endsWith('.html')) continue;
      await remote.put(d.name, f.slice(0, -5), fs.readFileSync(path.join(src, d.name, f), 'utf8'));
      console.log('  ✓', d.name + '/' + f);
    }
  }
  console.log('Done.');
})().catch((e) => { console.error(e.message); process.exit(1); });
