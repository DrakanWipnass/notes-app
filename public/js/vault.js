// In-memory vault index: file list, note contents, parsed links/tags/headings/frontmatter, link resolution.
export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
export const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac']);
export const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'ogv']);
export const ext = (p) => { const m = /\.([^./]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
export const basename = (p) => p.split('/').pop();
export const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
export const stem = (p) => basename(p).replace(/\.md$/i, '');
export const isMd = (p) => ext(p) === 'md';

export const vault = {
  name: '',
  root: '',
  files: [],          // [{path,type,size,mtime,ctime}]
  folders: new Set(),
  notes: new Map(),   // path -> content
  meta: new Map(),    // path -> {links, tags, headings, fm, aliases}
  byName: new Map(),  // lower basename (and stem for md) -> [paths]
};

// ---------- parsing ----------
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
export function splitFrontmatter(src) {
  const m = FM_RE.exec(src);
  if (!m) return { fm: null, body: src, fmLines: 0, raw: '' };
  let fm = null;
  try { fm = window.jsyaml.load(m[1]) || {}; } catch { fm = { _error: 'Invalid YAML' }; }
  if (typeof fm !== 'object' || Array.isArray(fm)) fm = { value: fm };
  return { fm, body: src.slice(m[0].length), fmLines: m[0].split('\n').length - 1, raw: m[1] };
}

/** Blank out code (fenced, inline) and comments so links/tags inside them are ignored — keeps offsets & line numbers. */
export function maskCode(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/^(\s*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\s*\2[^\n]*|$(?![\s\S]))/gm, blank)
    .replace(/%%[\s\S]*?%%/g, blank)
    .replace(/`[^`\n]+`/g, blank);
}

export const LINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
export const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export function parseLinkText(raw) {
  raw = raw.replace(/\\\|/g, '|');
  const bar = raw.indexOf('|');
  const target = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
  const alias = bar >= 0 ? raw.slice(bar + 1).trim() : '';
  const hash = target.indexOf('#');
  const file = hash >= 0 ? target.slice(0, hash).trim() : target;
  const sub = hash >= 0 ? target.slice(hash + 1).trim() : '';
  return { file, sub, alias, target };
}

export function parseNote(path, src) {
  const { fm, body, fmLines } = splitFrontmatter(src);
  const masked = maskCode(body);
  const lines = masked.split('\n');
  const links = [], tags = new Set(), headings = [];
  lines.forEach((line, i) => {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2].replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2'), line: i + fmLines });
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(line))) links.push({ ...parseLinkText(m[2]), embed: !!m[1], line: i + fmLines });
    // markdown links to local notes: [text](Some%20Note.md)
    const mdl = /\[[^\]]*\]\(([^)\s]+\.md)(#[^)]*)?\)/gi;
    while ((m = mdl.exec(line))) { if (!/^[a-z]+:/i.test(m[1])) links.push({ file: decodeURI(m[1]), sub: (m[2] || '').slice(1), alias: '', embed: false, line: i + fmLines }); }
    if (!h || h[1].length) {
      TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(h ? line.replace(/^#{1,6}\s/, '  ') : line))) tags.add(m[2]);
    }
  });
  const fmTags = fm && (fm.tags ?? fm.tag);
  for (const t of Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? fmTags.split(/[,\s]+/) : []) if (t) tags.add(String(t).replace(/^#/, ''));
  const al = fm && (fm.aliases ?? fm.alias);
  const aliases = (Array.isArray(al) ? al : typeof al === 'string' ? [al] : []).map(String);
  return { links, tags: [...tags], headings, fm, aliases };
}

// ---------- index maintenance ----------
export function setFiles(list) {
  vault.files = list.filter((f) => f.type === 'file');
  vault.folders = new Set(list.filter((f) => f.type === 'folder').map((f) => f.path));
  rebuildNames();
}
function rebuildNames() {
  vault.byName = new Map();
  const add = (k, p) => { k = k.toLowerCase(); if (!vault.byName.has(k)) vault.byName.set(k, []); vault.byName.get(k).push(p); };
  for (const f of vault.files) {
    add(basename(f.path), f.path);
    if (isMd(f.path)) add(stem(f.path), f.path);
  }
  for (const [p, m] of vault.meta) for (const a of m.aliases) add(a, p);
}
export function setNote(path, content) {
  vault.notes.set(path, content);
  const before = JSON.stringify(vault.meta.get(path)?.aliases || []);
  vault.meta.set(path, parseNote(path, content));
  if (!vault.files.some((f) => f.path === path)) vault.files.push({ path, type: 'file', size: content.length, mtime: Date.now(), ctime: Date.now() });
  if (JSON.stringify(vault.meta.get(path).aliases) !== before) rebuildNames();
}
export function dropNote(path) { vault.notes.delete(path); vault.meta.delete(path); }
export function loadAll(files, notes) {
  setFiles(files);
  vault.notes = new Map(Object.entries(notes));
  vault.meta = new Map([...vault.notes].map(([p, c]) => [p, parseNote(p, c)]));
  rebuildNames();
}

/** Resolve a link like "Note", "folder/Note", "image.png", "Note.md" relative to `from` — Obsidian's shortest-path rules. */
export function resolve(name, from = '') {
  if (!name) return from || null;
  name = name.replace(/\\/g, '/').replace(/^\.?\//, '');
  try { name = decodeURIComponent(name); } catch {}
  const lower = name.toLowerCase();
  const exact = vault.files.find((f) => { const p = f.path.toLowerCase(); return p === lower || p === lower + '.md'; });
  if (exact) return exact.path;
  // relative to the current note's folder ("./img.png", "../x")
  if (from && name.includes('/')) {
    const parts = dirname(from).split('/').filter(Boolean);
    for (const seg of name.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
    const rel = parts.join('/').toLowerCase();
    const hit = vault.files.find((f) => { const p = f.path.toLowerCase(); return p === rel || p === rel + '.md'; });
    if (hit) return hit.path;
  }
  const base = basename(lower);
  let cands = vault.byName.get(base) || [];
  if (name.includes('/')) cands = cands.filter((p) => { const pl = p.toLowerCase(); return pl.endsWith('/' + lower) || pl.endsWith('/' + lower + '.md'); });
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const dir = dirname(from);
  const same = cands.find((p) => dirname(p) === dir);
  if (same) return same;
  // prefer .md on stem collisions ("Pipeline" vs "Pipeline.html"), then the shortest path
  return [...cands].sort((a, b) => (isMd(b) - isMd(a)) || a.split('/').length - b.split('/').length || a.length - b.length)[0];
}

/** Shortest unambiguous link text for a path (what Obsidian inserts). */
export function linkTextFor(path) {
  const s = isMd(path) ? stem(path) : basename(path);
  const hits = vault.byName.get(s.toLowerCase()) || [];
  if (hits.length <= 1) return s;
  return isMd(path) ? path.replace(/\.md$/i, '') : path;
}

export function resolvedLinks(path) {
  const m = vault.meta.get(path);
  return m ? m.links.map((l) => ({ ...l, resolved: l.file ? resolve(l.file, path) : path })) : [];
}

export function backlinks(target) {
  const out = [];
  for (const [p] of vault.meta) {
    if (p === target) continue;
    const hits = resolvedLinks(p).filter((l) => l.resolved === target);
    if (hits.length) out.push({ path: p, hits });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function allTags() {
  const counts = new Map();
  for (const [, m] of vault.meta) for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

/** Text of a heading's section (heading line excluded), or a ^block reference's paragraph. */
export function extractSection(src, sub) {
  if (!sub) return src;
  const { body } = splitFrontmatter(src);
  const lines = body.split('\n');
  if (sub.startsWith('^')) {
    const id = sub.slice(1);
    const i = lines.findIndex((l) => l.trimEnd().endsWith('^' + id));
    if (i < 0) return null;
    let s = i; while (s > 0 && lines[s - 1].trim()) s--;
    return lines.slice(s, i + 1).join('\n').replace(new RegExp('\\s*\\^' + id + '\\s*$'), '');
  }
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const want = norm(sub.split('#').pop());
  const masked = maskCode(body).split('\n');
  let start = -1, level = 0;
  for (let i = 0; i < masked.length; i++) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(masked[i]);
    if (!h) continue;
    if (start < 0 && norm(h[2]) === want) { start = i; level = h[1].length; continue; }
    if (start >= 0 && h[1].length <= level) return lines.slice(start + 1, i).join('\n');
  }
  return start >= 0 ? lines.slice(start + 1).join('\n') : null;
}

// ---------- search ----------
export function search(query) {
  const terms = [], filters = { tag: [], path: [], file: [] };
  for (const tok of query.match(/"[^"]+"|\S+/g) || []) {
    const m = /^(tag|path|file):(.+)$/i.exec(tok);
    if (m) filters[m[1].toLowerCase()].push(m[2].replace(/^#/, '').replace(/"/g, '').toLowerCase());
    else terms.push(tok.replace(/"/g, '').toLowerCase());
  }
  const results = [];
  for (const [path, content] of vault.notes) {
    const meta = vault.meta.get(path);
    const pl = path.toLowerCase();
    if (filters.path.some((f) => !pl.includes(f))) continue;
    if (filters.file.some((f) => !stem(path).toLowerCase().includes(f))) continue;
    if (filters.tag.some((f) => !meta.tags.some((t) => t.toLowerCase() === f || t.toLowerCase().startsWith(f + '/')))) continue;
    const lower = content.toLowerCase();
    if (terms.some((t) => !lower.includes(t) && !pl.includes(t))) continue;
    const matches = [];
    if (terms.length) {
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        const ll = line.toLowerCase();
        if (terms.some((t) => ll.includes(t)) && matches.length < 20) matches.push({ line: i, text: line });
      });
    } else if (filters.tag.length) {
      content.split('\n').forEach((line, i) => { if (filters.tag.some((t) => line.toLowerCase().includes('#' + t)) && matches.length < 20) matches.push({ line: i, text: line }); });
    }
    results.push({ path, matches, score: (terms.some((t) => stem(path).toLowerCase().includes(t)) ? 100 : 0) + matches.length });
  }
  return { results: results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)), terms: terms.concat(filters.tag.map((t) => '#' + t)) };
}

/** Fuzzy subsequence match; returns {score, idx[]} or null. */
export function fuzzy(q, text) {
  if (!q) return { score: 0, idx: [] };
  const t = text.toLowerCase(), ql = q.toLowerCase();
  const sub = t.indexOf(ql);
  if (sub >= 0) return { score: 1000 - sub * 2 - t.length * 0.1 + (sub === 0 ? 200 : 0), idx: [...Array(ql.length)].map((_, i) => sub + i) };
  let ti = 0, score = 0, last = -1;
  const idx = [];
  for (const ch of ql) {
    if (ch === ' ') continue;
    const f = t.indexOf(ch, ti);
    if (f < 0) return null;
    score += f === last + 1 ? 15 : 1;
    if (f === 0 || /[\s/\-_]/.test(t[f - 1])) score += 10;
    idx.push(f); last = f; ti = f + 1;
  }
  return { score: score - t.length * 0.1, idx };
}
export function highlightIdx(text, idx) {
  const set = new Set(idx);
  let out = '';
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<b>${esc(text[i])}</b>` : esc(text[i]);
  return out;
}
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
