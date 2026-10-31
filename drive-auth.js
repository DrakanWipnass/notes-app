// One-time helper: signs you in to Google and prints a refresh token for the app.
// Usage:  node drive-auth.js <CLIENT_ID> <CLIENT_SECRET>
//   (or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
const http = require('http');
const { exec } = require('child_process');

const id = process.argv[2] || process.env.GOOGLE_CLIENT_ID;
const secret = process.argv[3] || process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) { console.error('Usage: node drive-auth.js <CLIENT_ID> <CLIENT_SECRET>'); process.exit(1); }

const PORT = 53682;
const redirect = `http://localhost:${PORT}`;
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent',
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  const code = u.searchParams.get('code');
  if (!code) { res.end(u.searchParams.get('error') ? 'Error: ' + u.searchParams.get('error') : 'Waiting…'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!j.refresh_token) {
    res.end('No refresh token received. Check the terminal.');
    console.error('Failed:', j);
  } else {
    res.end('Done! You can close this tab and go back to the terminal.');
    console.log('\nGOOGLE_CLIENT_ID=' + id + '\nGOOGLE_CLIENT_SECRET=' + secret + '\nGOOGLE_REFRESH_TOKEN=' + j.refresh_token + '\n');
    console.log('Keep these three values secret. Set them as environment variables for the app.');
  }
  server.close();
});
server.listen(PORT, () => {
  console.log('Opening browser to sign in to Google…\nIf it does not open, visit:\n' + authUrl + '\n');
  exec(process.platform === 'win32' ? `start "" "${authUrl}"` : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`);
});
