// GitHub sync through the local `git` CLI (uses whatever credentials git already has — Git Credential Manager on Windows,
// SSH keys, or a token in the remote URL). Every sync = commit local changes -> pull (merge) -> push.
// Merge conflicts are left as <<<<<<< markers in the notes; fix them in the editor and sync again to finish the merge.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 20e6, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const out = { code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
      if (err && !allowFail) {
        const e = new Error(`git ${args[0]} failed: ${out.stderr || out.stdout || err.message}`);
        e.git = out;
        return reject(e);
      }
      resolve(out);
    });
  });
}
const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

const GITIGNORE = '.trash/\n.DS_Store\nThumbs.db\n';

async function currentBranch(dir) {
  const r = await run(dir, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true });
  return r.code === 0 ? r.stdout : 'main';
}
async function hasCommits(dir) {
  return (await run(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
}
async function remoteUrl(dir) {
  const r = await run(dir, ['remote', 'get-url', 'origin'], { allowFail: true });
  return r.code === 0 ? r.stdout : '';
}
const redact = (u) => u.replace(/\/\/[^@/]+@/, '//***@'); // hide tokens embedded in https://TOKEN@github.com/...

async function status(dir) {
  if (!isRepo(dir)) return { repo: false };
  const branch = await currentBranch(dir);
  const remote = await remoteUrl(dir);
  const porcelain = await run(dir, ['status', '--porcelain', '-uall'], { allowFail: true });
  const changes = porcelain.stdout ? porcelain.stdout.split('\n').map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^"|"$/g, '') })) : [];
  let ahead = 0, behind = 0, upstream = '';
  const up = await run(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
  if (up.code === 0) {
    upstream = up.stdout;
    const c = await run(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], { allowFail: true });
    if (c.code === 0) [ahead, behind] = c.stdout.split(/\s+/).map(Number);
  }
  const last = await run(dir, ['log', '-1', '--format=%cI|%s'], { allowFail: true });
  const [lastDate, ...msg] = last.code === 0 ? last.stdout.split('|') : [];
  const merging = fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
  const conflicts = changes.filter((c) => ['UU', 'AA', 'DU', 'UD'].includes(c.code)).map((c) => c.path);
  return { repo: true, branch, remote: redact(remote), upstream, ahead, behind, changes, lastCommit: lastDate ? { date: lastDate, message: msg.join('|') } : null, merging, conflicts };
}

async function commitAll(dir, message) {
  await run(dir, ['add', '-A']);
  const st = await run(dir, ['status', '--porcelain'], { allowFail: true });
  const merging = fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
  if (!st.stdout && !merging) return false;
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const msg = message || `vault backup: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  await run(dir, ['commit', '-m', msg, '--no-verify']);
  return true;
}

/** Remote branch that exists on origin (wanted branch, else origin's default), or '' if remote is empty. */
async function remoteBranch(dir, wanted) {
  const heads = await run(dir, ['ls-remote', '--heads', 'origin'], { allowFail: true });
  if (heads.code !== 0) throw new Error('Cannot reach the remote: ' + (heads.stderr || heads.stdout));
  const names = heads.stdout.split('\n').filter(Boolean).map((l) => l.split('refs/heads/')[1]);
  if (!names.length) return '';
  if (wanted && names.includes(wanted)) return wanted;
  const sym = await run(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], { allowFail: true });
  const m = sym.stdout.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
  return m ? m[1] : names.includes('main') ? 'main' : names[0];
}

async function sync(dir, message) {
  if (!isRepo(dir)) return { ok: false, error: 'The vault is not connected to GitHub yet (Settings → GitHub sync).' };
  const log = [];
  try {
    const st = await status(dir);
    if (st.conflicts.length) {
      // user must remove conflict markers first; if none remain we can conclude the merge
      const still = st.conflicts.filter((p) => { try { return /^<{7} |^>{7} /m.test(fs.readFileSync(path.join(dir, p), 'utf8')); } catch { return false; } });
      if (still.length) return { ok: false, conflict: true, files: still, error: 'Resolve the conflict markers (<<<<<<< / >>>>>>>) in these notes, then sync again.' };
    }
    if (await commitAll(dir, message)) log.push('Committed local changes');
    if (!(await remoteUrl(dir))) return { ok: true, log: log.concat('No remote configured — committed locally only') };

    const branch = await currentBranch(dir);
    const rb = await remoteBranch(dir, branch);
    if (rb) {
      const pull = await run(dir, ['pull', '--no-rebase', '--no-edit', 'origin', rb], { allowFail: true });
      if (pull.code !== 0) {
        const s2 = await status(dir);
        if (s2.conflicts.length) return { ok: false, conflict: true, files: s2.conflicts, log, error: 'Merge conflict. The conflicting notes now contain <<<<<<< markers — edit them, then sync again.' };
        throw new Error(pull.stderr || pull.stdout);
      }
      log.push(/Already up to date/i.test(pull.stdout) ? 'Already up to date with GitHub' : 'Pulled changes from GitHub');
    }
    if (await hasCommits(dir)) {
      const ahead = rb ? await run(dir, ['rev-list', '--count', `origin/${rb}..HEAD`], { allowFail: true }) : { code: 0, stdout: '1' };
      if (ahead.code !== 0 || Number(ahead.stdout) > 0) {
        await run(dir, ['push', '-u', 'origin', `HEAD:${rb || branch}`]);
        log.push('Pushed to GitHub');
      }
    }
    return { ok: true, log, status: await status(dir) };
  } catch (e) {
    return { ok: false, error: e.message, log };
  }
}

/** Connect the vault folder to a GitHub repo (works for empty or non-empty vaults and empty or non-empty repos). */
async function setup(dir, remote, branch) {
  if (!remote) return { ok: false, error: 'Enter the repository URL, e.g. https://github.com/you/notes.git' };
  const log = [];
  try {
    if (!isRepo(dir)) {
      await run(dir, ['init']);
      log.push('Initialised git in the vault');
    }
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
    if (await remoteUrl(dir)) await run(dir, ['remote', 'set-url', 'origin', remote]);
    else await run(dir, ['remote', 'add', 'origin', remote]);
    log.push('Remote set to ' + redact(remote));

    const rb = await remoteBranch(dir, branch);
    const local = branch || rb || 'main';
    if (!(await hasCommits(dir))) await run(dir, ['symbolic-ref', 'HEAD', `refs/heads/${local}`]);
    await commitAll(dir, 'vault: initial commit');

    if (rb) {
      await run(dir, ['fetch', 'origin', rb]);
      if (await hasCommits(dir)) {
        const m = await run(dir, ['merge', '--allow-unrelated-histories', '--no-edit', `origin/${rb}`], { allowFail: true });
        if (m.code !== 0) {
          const s = await status(dir);
          return { ok: false, conflict: true, files: s.conflicts, log, error: 'Your local notes and the GitHub repo both changed the same files. Resolve the <<<<<<< markers, then press Sync.' };
        }
      } else {
        await run(dir, ['reset', '--hard', `origin/${rb}`]);
      }
      log.push(`Merged GitHub branch ${rb}`);
    }
    if (await hasCommits(dir)) {
      await run(dir, ['push', '-u', 'origin', `HEAD:${rb || local}`]);
      log.push('Pushed vault to GitHub');
    }
    return { ok: true, log, status: await status(dir) };
  } catch (e) {
    return { ok: false, error: e.message, log };
  }
}

async function log(dir, file) {
  if (!isRepo(dir) || !(await hasCommits(dir))) return [];
  const args = ['log', '-n', '30', '--format=%h|%cI|%an|%s'];
  if (file) args.push('--follow', '--', file);
  const r = await run(dir, args, { allowFail: true });
  return r.stdout ? r.stdout.split('\n').map((l) => { const [hash, date, author, ...m] = l.split('|'); return { hash, date, author, message: m.join('|') }; }) : [];
}

module.exports = { status, sync, setup, log };
