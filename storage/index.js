// Picks the backend from environment variables:
//   GITHUB_TOKEN + GITHUB_REPO  -> private GitHub repo   (recommended for hosting)
//   GOOGLE_REFRESH_TOKEN        -> Google Drive
//   otherwise                   -> local folder (./notes or NOTES_DIR)
const path = require('path');

module.exports = function pick() {
  const e = process.env;
  if (e.GITHUB_TOKEN) {
    if (!e.GITHUB_REPO) throw new Error('Set GITHUB_REPO, e.g. DrakanWipnass/f29-notes');
    return require('./github')({ token: e.GITHUB_TOKEN, repo: e.GITHUB_REPO, branch: e.GITHUB_BRANCH || '', prefix: e.GITHUB_PATH || '' });
  }
  if (e.GOOGLE_REFRESH_TOKEN) {
    if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET too');
    return require('./drive')({
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      refreshToken: e.GOOGLE_REFRESH_TOKEN,
      rootName: e.DRIVE_ROOT_NAME || 'F29-Notes',
      rootId: e.DRIVE_ROOT_ID || '',
    });
  }
  return require('./local')(e.NOTES_DIR || path.join(__dirname, '..', 'notes'));
};
