// Notebook — main application: workspace/tabs, file explorer, sidebars, commands, settings, GitHub sync.
import { api, rawUrl } from './api.js';
import {
  vault, loadAll, setFiles, setNote, dropNote, resolve, resolvedLinks, backlinks, allTags, search, fuzzy, highlightIdx,
  esc, ext, basename, dirname, stem, isMd, linkTextFor, splitFrontmatter, parseLinkText, IMAGE_EXT, AUDIO_EXT, VIDEO_EXT,
} from './vault.js';
import { renderInto, createPreviewRoot, hooks, makeIframe, fullscreenDoc, icon } from './markdown.js';
import { editor, toggleTask } from './editor.js';
import { ForceGraph, buildGraph } from './graph.js';
import { notice, prompt, confirm, suggest, menu, modal, icons } from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TEXT_EDITABLE = new Set(['html', 'htm', 'css', 'js', 'json', 'txt', 'csv', 'svg', 'yml', 'yaml', 'xml']);
const CM_MODE = { html: 'htmlmixed', htm: 'htmlmixed', svg: 'xml', xml: 'xml', css: 'css', js: 'javascript', json: { name: 'javascript', json: true }, yml: 'yaml', yaml: 'yaml' };

// ---------------- settings & persisted state ----------------
const DEFAULTS = {
  theme: 'dark', fontSize: 16, readable: true, accentHue: 158, defaultMode: 'source', spellcheck: false, lineNumbers: false, indentWithTabs: true,
  newNoteLocation: 'root', newNoteFolder: '', attachmentFolder: 'attachments', confirmDelete: true,
  dailyFolder: 'Daily', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '',
  autoSync: 0, syncOnStart: true, commitMessage: '', sort: 'name-asc',
  leftW: 260, rightW: 280, leftCollapsed: false, rightCollapsed: false, leftPane: 'files', rightPane: 'backlinks',
  bookmarks: [], graphTags: false, graphOrphans: true, graphAttach: false,
};
const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...d }; } };
const S = load('mdvault.settings', DEFAULTS);
if (S.accentHue === 254) S.accentHue = 158; // old purple default -> emerald
const saveSettings = () => { try { localStorage.setItem('mdvault.settings', JSON.stringify(S)); } catch {} };
let expanded = new Set(); try { expanded = new Set(JSON.parse(localStorage.getItem('mdvault.expanded') || '[]')); } catch {}
const saveExpanded = () => { try { localStorage.setItem('mdvault.expanded', JSON.stringify([...expanded])); } catch {} };

// ---------------- workspace state ----------------
let tabs = [], activeId = null, tabSeq = 0, closedTabs = [];
const dirty = new Set(), saveTimers = new Map(), saving = new Map();
const textCache = new Map(); // non-md editable text files (html/css/...)
let graph = null, localGraph = null, git = { status: null, busy: false };

const cur = () => tabs.find((t) => t.id === activeId);
function saveWorkspace() {
  try { localStorage.setItem('mdvault.workspace', JSON.stringify({ tabs: tabs.map(({ id, type, path, mode, hist, hpos }) => ({ id, type, path, mode, hist, hpos })), activeId })); } catch {}
}
const fileExists = (p) => vault.files.some((f) => f.path === p);
const kindOf = (p) => (isMd(p) ? 'note' : TEXT_EDITABLE.has(ext(p)) ? 'text' : 'media');

// ---------------- appearance ----------------
function applyAppearance() {
  const r = document.documentElement;
  r.dataset.theme = S.theme;
  r.style.setProperty('--font-size', S.fontSize + 'px');
  r.style.setProperty('--accent-h', S.accentHue);
  r.style.setProperty('--left-w', S.leftW + 'px');
  r.style.setProperty('--right-w', S.rightW + 'px');
  document.body.classList.toggle('no-readable', !S.readable);
  $('#app').classList.toggle('left-collapsed', S.leftCollapsed);
  $('#app').classList.toggle('right-collapsed', S.rightCollapsed);
  $('meta[name=theme-color]').content = S.theme === 'light' ? '#ffffff' : '#1e1e1e';
}

// ---------------- vault loading ----------------
async function loadVault() {
  const [{ files, name, vault: root }, notes] = await Promise.all([api.files(), api.notes()]);
  vault.name = name; vault.root = root;
  loadAll(files, notes);
  $('#vault-name').innerHTML = `<img src="/icon.svg" alt="" width="16" height="16"><span title="${esc(root)}">${esc(name)}</span>`;
  document.title = `${name} - Notebook`;
}

// ---------------- tabs ----------------
function newTab(path = null, opts = {}) {
  const t = { id: 't' + ++tabSeq, type: path ? kindOf(path) : 'empty', path, mode: opts.mode || defaultModeFor(path), hist: path ? [path] : [], hpos: path ? 0 : -1 };
  const idx = tabs.findIndex((x) => x.id === activeId);
  tabs.splice(idx + 1, 0, t);
  activate(t.id);
  return t;
}
function defaultModeFor(path) {
  if (!path) return S.defaultMode;
  const k = kindOf(path);
  return k === 'media' ? 'preview' : k === 'text' ? (ext(path).startsWith('htm') ? 'preview' : 'source') : S.defaultMode;
}
function activate(id) {
  const prev = cur();
  if (prev && prev.type !== 'graph') rememberScroll(prev);
  activeId = id;
  renderTabs();
  renderView();
  saveWorkspace();
}
function closeTab(id = activeId) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = tabs[i];
  if (t.path && dirty.has(t.path)) save(t.path);
  closedTabs.push({ path: t.path, type: t.type, mode: t.mode });
  tabs.splice(i, 1);
  if (!tabs.length) { tabs.push({ id: 't' + ++tabSeq, type: 'empty', path: null, mode: S.defaultMode, hist: [], hpos: -1 }); }
  if (activeId === id) activeId = (tabs[i] || tabs[i - 1]).id;
  renderTabs(); renderView(); saveWorkspace();
}
function reopenClosed() {
  const t = closedTabs.pop();
  if (!t) return;
  if (t.type === 'graph') openGraph(true); else if (t.path && fileExists(t.path)) openFile(t.path, { newTab: true, mode: t.mode });
}

/** Open a vault file. opts: {newTab, sub (heading/^block), line, mode, focusTitle} */
function openFile(path, opts = {}) {
  if (!path) return;
  let t = cur();
  if (opts.newTab || !t || t.type === 'graph') t = newTab(null);
  if (t.path !== path) {
    if (t.path) rememberScroll(t);
    const prevType = t.type;
    t.hist = t.hist.slice(0, t.hpos + 1).concat(path);
    t.hpos = t.hist.length - 1;
    t.path = path;
    t.type = kindOf(path);
    t.scroll = 0; t.cursor = null;
    // a tab keeps its editing/reading mode while you move between notes (like Obsidian)
    t.mode = opts.mode || (t.type === 'note' && prevType === 'note' ? t.mode : defaultModeFor(path));
  } else if (opts.mode) t.mode = opts.mode;
  activeId = t.id;
  renderTabs();
  renderView().then(() => {
    if (opts.sub) scrollToSub(opts.sub);
    else if (opts.line != null) goToLine(opts.line);
    if (opts.focusTitle) { const it = t.mode === 'preview' ? $('#inline-title-prev') : $('#inline-title-src'); it.focus(); it.select(); }
  });
  saveWorkspace();
}
function navigate(dir) {
  const t = cur();
  if (!t || t.hpos + dir < 0 || t.hpos + dir >= t.hist.length) return;
  rememberScroll(t);
  t.hpos += dir;
  t.path = t.hist[t.hpos];
  if (!fileExists(t.path)) { t.hist.splice(t.hpos, 1); t.hpos = Math.min(t.hpos, t.hist.length - 1); t.path = t.hist[t.hpos] || null; }
  t.type = t.path ? kindOf(t.path) : 'empty';
  renderTabs(); renderView(); saveWorkspace();
}

function tabTitle(t) { return t.type === 'graph' ? 'Graph view' : t.path ? (isMd(t.path) ? stem(t.path) : basename(t.path)) : 'New tab'; }
function tabIcon(t) { return t.type === 'graph' ? 'git-fork' : t.type === 'media' ? (IMAGE_EXT.has(ext(t.path)) ? 'image' : 'file') : t.type === 'text' ? 'file-code' : t.type === 'empty' ? '' : ''; }
function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = tabs.map((t) => `<div class="tab${t.id === activeId ? ' is-active' : ''}${t.path && dirty.has(t.path) ? ' dirty' : ''}" data-id="${t.id}" draggable="true" title="${esc(t.path || tabTitle(t))}">
      ${tabIcon(t) ? `<span class="tab-icon">${icon(tabIcon(t), 14)}</span>` : ''}<span class="tab-title">${esc(tabTitle(t))}</span>
      <button class="tab-close" title="Close (Alt+W)">${icon('x', 14)}</button></div>`).join('');
  el.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function bindTabs() {
  const el = $('#tabs');
  el.addEventListener('mousedown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    if (e.button === 1) { e.preventDefault(); closeTab(tab.dataset.id); return; }
    if (e.target.closest('.tab-close')) return;
    if (tab.dataset.id !== activeId) activate(tab.dataset.id);
  });
  el.addEventListener('click', (e) => { if (e.target.closest('.tab-close')) closeTab(e.target.closest('.tab').dataset.id); });
  el.addEventListener('dblclick', (e) => { if (!e.target.closest('.tab')) newTab(); });
  el.addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.tab'); if (!tab) return;
    e.preventDefault();
    const t = tabs.find((x) => x.id === tab.dataset.id);
    menu(e.clientX, e.clientY, [
      { label: 'Close', icon: 'x', action: () => closeTab(t.id) },
      { label: 'Close others', icon: 'x-circle', action: () => { tabs = [t]; activeId = t.id; renderTabs(); renderView(); saveWorkspace(); } },
      { label: 'Close tabs to the right', icon: 'arrow-right-to-line', action: () => { tabs = tabs.slice(0, tabs.indexOf(t) + 1); if (!tabs.includes(cur())) activeId = t.id; renderTabs(); renderView(); saveWorkspace(); } },
      ...(t.path ? ['sep', ...fileMenuItems(t.path)] : []),
    ]);
  });
  // drag to reorder
  let dragId = null;
  el.addEventListener('dragstart', (e) => { const tab = e.target.closest('.tab'); if (!tab) return; dragId = tab.dataset.id; tab.classList.add('dragging'); const t = tabs.find((x) => x.id === dragId); if (t?.path) e.dataTransfer.setData('text/x-mdvault-path', t.path); });
  el.addEventListener('dragend', () => { dragId = null; renderTabs(); });
  el.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const over = e.target.closest('.tab');
    const from = tabs.findIndex((t) => t.id === dragId);
    const [t] = tabs.splice(from, 1);
    const to = over ? tabs.findIndex((x) => x.id === over.dataset.id) : tabs.length;
    tabs.splice(to < 0 ? tabs.length : to, 0, t);
    renderTabs(); saveWorkspace();
  });
}

// ---------------- main view ----------------
let renderSeq = 0;
async function renderView() {
  const t = cur();
  const vc = $('#view-content');
  const seq = ++renderSeq;
  hidePopover();
  if (!t || t.type === 'empty' || (t.path && !fileExists(t.path) && t.type !== 'graph')) {
    vc.dataset.view = 'empty';
    $('#view-title').innerHTML = '';
    $('#view-header').style.visibility = t?.hist?.length > 1 ? 'visible' : 'hidden';
    editor.path = null;
    updateStatus(); updateRight(); highlightTree();
    return;
  }
  $('#view-header').style.visibility = 'visible';
  if (t.type === 'graph') {
    vc.dataset.view = 'graph';
    $('#view-title').textContent = 'Graph view';
    setHeaderButtons(t);
    editor.path = null;
    refreshGraph();
    updateStatus(); updateRight(); highlightTree();
    return;
  }
  vc.dataset.view = 'note';
  const nv = $('#note-view');
  if (t.type === 'media') t.mode = 'preview';
  nv.dataset.mode = t.mode;
  setHeaderButtons(t);
  renderTitle(t.path);

  if (t.type === 'note' || t.type === 'text') {
    const content = await getContent(t.path);
    if (seq !== renderSeq) return;
    editor.cm.setOption('lineNumbers', t.type === 'text' || S.lineNumbers);
    editor.open(t.path, content, t.type === 'note' ? 'mdvault' : CM_MODE[ext(t.path)] || null);
  } else editor.path = null;
  if (t.mode !== 'source') await renderPreview(t);
  if (seq !== renderSeq) return;
  restoreScroll(t);
  if (t.mode !== 'preview' && document.activeElement?.closest('.sidebar, .modal') == null) setTimeout(() => editor.cm.refresh(), 0);
  updateStatus(); updateRight(); highlightTree();
}
function setHeaderButtons(t) {
  const mb = $('#mode-btn'), sb = $('#split-btn'), bb = $('#bookmark-btn');
  const isFile = t.type === 'note' || t.type === 'text';
  mb.style.display = isFile ? '' : 'none';
  sb.style.display = isFile ? '' : 'none';
  bb.style.display = t.path ? '' : 'none';
  mb.innerHTML = icon(t.mode === 'preview' ? 'pencil' : 'book-open', 16);
  mb.title = t.mode === 'preview' ? 'Edit (Ctrl+E)' : 'Reading view (Ctrl+E)';
  sb.classList.toggle('is-active', t.mode === 'split');
  bb.classList.toggle('is-active', !!t.path && S.bookmarks.includes(t.path));
  bb.innerHTML = icon(t.path && S.bookmarks.includes(t.path) ? 'bookmark-check' : 'bookmark', 16);
}
function renderTitle(path) {
  const parts = path.split('/');
  const name = isMd(path) ? stem(path) : basename(path);
  $('#view-title').innerHTML = parts.slice(0, -1).map((p) => `<span class="crumb">${esc(p)}</span><span class="crumb-sep">/</span>`).join('') + `<span class="title-name" title="Click to rename">${esc(name)}</span>`;
  for (const id of ['#inline-title-src', '#inline-title-prev']) { const it = $(id); it.value = name; it.dataset.path = path; }
  $('#inline-title-prev').readOnly = !isMd(path) && kindOf(path) === 'media';
}

async function getContent(path) {
  if (isMd(path)) {
    if (!vault.notes.has(path)) { try { setNote(path, await api.read(path)); } catch { return ''; } }
    return vault.notes.get(path);
  }
  if (!textCache.has(path)) { try { textCache.set(path, await api.read(path)); } catch { textCache.set(path, ''); } }
  return textCache.get(path);
}

let previewRoot = null;
async function renderPreview(t = cur()) {
  if (!t || !t.path) return;
  previewRoot = createPreviewRoot($('#preview-host'));
  const content = previewRoot.querySelector('.content');
  const k = t.type;
  if (k === 'note') return renderInto(content, vault.notes.get(t.path) ?? '', t.path);
  const url = rawUrl(t.path), e = ext(t.path);
  content.innerHTML = '';
  if (k === 'text' && (e === 'html' || e === 'htm')) {
    const wrap = document.createElement('div');
    wrap.className = 'html-embed';
    wrap.appendChild(makeIframe(await getContent(t.path), dirname(t.path), 0));
    content.appendChild(wrap);
  } else if (k === 'text') content.innerHTML = `<pre><code>${esc(await getContent(t.path))}</code></pre>`;
  else if (IMAGE_EXT.has(e)) content.innerHTML = `<div style="text-align:center"><img src="${url}" alt=""></div>`;
  else if (e === 'pdf') content.innerHTML = `<iframe src="${url}" style="width:100%;height:calc(100vh - 140px);border:0"></iframe>`;
  else if (AUDIO_EXT.has(e)) content.innerHTML = `<audio controls src="${url}" style="width:100%"></audio>`;
  else if (VIDEO_EXT.has(e)) content.innerHTML = `<video controls src="${url}" style="max-width:100%"></video>`;
  else content.innerHTML = `<p>No preview for this file type. <a href="${url}" target="_blank" class="external-link">Open raw file</a></p>`;
}
const previewScroller = () => $('#preview-scroller'), sourceScroller = () => $('#source-scroller');
function rememberScroll(t) {
  if (!t || !t.path) return;
  t.scroll = t.mode === 'preview' ? previewScroller().scrollTop : sourceScroller().scrollTop;
  if (t.type !== 'media' && editor.path === t.path) t.cursor = editor.cm.getCursor();
}
function restoreScroll(t) {
  const y = t.scroll || 0;
  requestAnimationFrame(() => {
    if (t.mode === 'preview') previewScroller().scrollTop = y;
    else { sourceScroller().scrollTop = y; if (t.cursor && editor.path === t.path) editor.cm.setCursor(t.cursor); }
  });
}

function topLine(t) {
  if (t.mode === 'preview') {
    const sc = previewScroller(), top = sc.getBoundingClientRect().top;
    if (sc.scrollTop < 40 || !previewRoot) return 0;
    const el = [...previewRoot.querySelectorAll('[data-line]')].find((e) => e.getBoundingClientRect().bottom > top + 4);
    return el ? +el.dataset.line : 0;
  }
  const sc = sourceScroller();
  if (sc.scrollTop < 40 || editor.path !== t.path) return 0;
  return editor.cm.lineAtHeight(sc.getBoundingClientRect().top + 4, 'window');
}
function scrollToLineTop(t, line) {
  if (!line) { previewScroller().scrollTop = 0; sourceScroller().scrollTop = 0; return; }
  if (t.mode === 'preview') {
    const sc = previewScroller();
    const els = previewRoot ? [...previewRoot.querySelectorAll('[data-line]')].filter((e) => +e.dataset.line <= line) : [];
    const el = els[els.length - 1];
    if (el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 12;
  } else {
    const sc = sourceScroller();
    sc.scrollTop += editor.cm.charCoords({ line, ch: 0 }, 'window').top - sc.getBoundingClientRect().top - 12;
  }
}
function setMode(mode) {
  const t = cur();
  if (!t || (t.type !== 'note' && t.type !== 'text')) return;
  const line = topLine(t);
  if (t.path && dirty.has(t.path)) save(t.path);
  t.mode = mode;
  t.scroll = 0;
  renderView().then(() => requestAnimationFrame(() => {
    scrollToLineTop(t, line);
    if (mode !== 'preview') editor.cm.focus();
  }));
  saveWorkspace();
}

const normHeading = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function scrollToSub(sub) {
  const t = cur();
  if (!t) return;
  const want = normHeading(sub.split('#').pop().replace(/^\^/, ''));
  if (t.mode !== 'source' && previewRoot) {
    const el = sub.startsWith('^') ? null : [...previewRoot.querySelectorAll('[data-heading]')].find((h) => normHeading(h.dataset.heading) === want);
    if (el) { el.scrollIntoView({ block: 'start' }); flash(el); return; }
  }
  const meta = vault.meta.get(t.path);
  const h = meta?.headings.find((x) => normHeading(x.text) === want);
  let line = h?.line;
  if (line == null && sub.startsWith('^')) { const i = (vault.notes.get(t.path) || '').split('\n').findIndex((l) => l.trimEnd().endsWith(sub)); if (i >= 0) line = i; }
  if (line != null) goToLine(line);
}
function goToLine(line) {
  const t = cur();
  if (!t) return;
  if (t.mode === 'preview' && previewRoot) {
    const els = [...previewRoot.querySelectorAll('[data-line]')].filter((e) => +e.dataset.line <= line);
    const el = els[els.length - 1];
    if (el) { el.scrollIntoView({ block: 'center' }); flash(el); }
    return;
  }
  editor.goToLine(line);
}
function flash(el) { el.classList.remove('highlight-flash'); void el.offsetWidth; el.classList.add('highlight-flash'); }

// ---------------- editing & saving ----------------
let indexTimer = null, previewTimer = null;
editor.onChange = (path, value) => {
  if (isMd(path)) vault.notes.set(path, value); else textCache.set(path, value);
  if (!dirty.has(path)) { dirty.add(path); renderTabs(); }
  clearTimeout(saveTimers.get(path));
  saveTimers.set(path, setTimeout(() => save(path), 700));
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => { if (isMd(path)) setNote(path, vault.notes.get(path)); updateRight(); updateStatus(); }, 350);
  const t = cur();
  if (t?.mode === 'split' && t.path === path) { clearTimeout(previewTimer); previewTimer = setTimeout(() => { const y = previewScroller().scrollTop; renderPreview(t).then(() => { previewScroller().scrollTop = y; }); }, 350); }
  updateStatus();
};
async function save(path) {
  clearTimeout(saveTimers.get(path));
  if (!dirty.has(path)) return saving.get(path);
  const content = isMd(path) ? vault.notes.get(path) : textCache.get(path);
  if (content == null) return;
  dirty.delete(path);
  const p = (saving.get(path) || Promise.resolve()).then(() => api.write(path, content)).then(() => {
    if (isMd(path)) setNote(path, vault.notes.get(path) ?? content); // re-index the *latest* text (typing may have continued)
    $('#st-save').textContent = '';
    renderTabs();
    scheduleGitRefresh();
  }).catch((e) => {
    dirty.add(path);
    $('#st-save').textContent = '⚠ not saved';
    notice(`Could not save ${path}: ${e.message}`, { error: true });
  });
  saving.set(path, p);
  return p;
}
const flushAll = () => Promise.all([...dirty].map(save));
window.addEventListener('beforeunload', (e) => {
  if (!dirty.size) return;
  for (const p of dirty) {
    const body = isMd(p) ? vault.notes.get(p) : textCache.get(p);
    try { fetch('/api/file?path=' + encodeURIComponent(p), { method: 'PUT', headers: { 'X-MDVault': '1' }, body, keepalive: true }); } catch {}
  }
  e.preventDefault(); e.returnValue = '';
});

// ---------------- file operations ----------------
function uniquePath(folder, base, extn = '.md') {
  const pre = folder ? folder + '/' : '';
  let i = 0, p;
  do { p = `${pre}${i ? `${base} ${i}` : base}${extn}`; i++; } while (fileExists(p) || vault.folders.has(p));
  return p;
}
function newNoteFolder() {
  if (S.newNoteLocation === 'current') { const t = cur(); return t?.path ? dirname(t.path) : ''; }
  if (S.newNoteLocation === 'folder') return S.newNoteFolder.replace(/^\/|\/$/g, '');
  return '';
}
async function createNote(folder = newNoteFolder(), name = 'Untitled', content = '', opts = {}) {
  name = name.replace(/\.md$/i, '');
  const path = name.includes('/') ? name + '.md' : uniquePath(folder, name.replace(/[\\/:*?"<>|]/g, '-'));
  try {
    await api.write(path, content, { create: true });
  } catch (e) { if (e.status !== 409) return notice('Could not create note: ' + e.message, { error: true }); }
  setNote(path, content);
  addFolders(dirname(path));
  renderTree();
  openFile(path, { mode: opts.mode || (S.defaultMode === 'preview' ? 'source' : S.defaultMode), focusTitle: name === 'Untitled', newTab: opts.newTab });
  return path;
}
function addFolders(dir) { while (dir) { vault.folders.add(dir); expanded.add(dir); dir = dirname(dir); } saveExpanded(); }
async function createFolder(parent = '') {
  const name = await prompt('New folder', '', { placeholder: 'Folder name', cta: 'Create' });
  if (!name) return;
  const p = (parent ? parent + '/' : '') + name.replace(/[\\:*?"<>|]/g, '-');
  await api.mkdir(p);
  addFolders(p);
  renderTree();
}
async function renamePath(from, to) {
  if (!to || from === to) return;
  if (fileExists(to) || vault.folders.has(to)) return notice('A file with that name already exists', { error: true });
  await flushAll();
  let r;
  try { r = await api.rename(from, to); } catch (e) { return notice('Rename failed: ' + e.message, { error: true }); }
  const map = (p) => (p === from ? to : p && p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  for (const t of tabs) { t.path = map(t.path); t.hist = t.hist.map(map); }
  for (const p of [...editor.docs.keys()]) if (map(p) !== p) editor.rename(p, map(p));
  for (const p of [...textCache.keys()]) if (map(p) !== p) { textCache.set(map(p), textCache.get(p)); textCache.delete(p); }
  S.bookmarks = S.bookmarks.map(map); saveSettings();
  expanded = new Set([...expanded].map(map)); saveExpanded();
  await reloadFromDisk();
  if (r.changed?.length) notice(`Renamed. Updated links in ${r.changed.length} note${r.changed.length > 1 ? 's' : ''}.`);
}
async function renameFlow(path) {
  const isFolder = vault.folders.has(path);
  const name = isFolder ? basename(path) : isMd(path) ? stem(path) : basename(path);
  const v = await prompt(isFolder ? 'Rename folder' : 'Rename file', name, { cta: 'Rename', select: [0, isFolder || isMd(path) ? name.length : name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length] });
  if (!v || v === name) return;
  const dir = dirname(path);
  await renamePath(path, (dir ? dir + '/' : '') + v + (isFolder || !isMd(path) ? '' : '.md'));
}
async function deletePath(path) {
  const isFolder = vault.folders.has(path);
  if (S.confirmDelete && !(await confirm(`Delete ${isFolder ? 'folder' : 'file'}`, `Are you sure you want to delete “${esc(path)}”?<br><br>It will be moved to the vault's <code>.trash</code> folder.`))) return;
  try { await api.remove(path); } catch (e) { return notice('Delete failed: ' + e.message, { error: true }); }
  const gone = (p) => p === path || (p && p.startsWith(path + '/'));
  for (const p of [...vault.notes.keys()]) if (gone(p)) { dropNote(p); editor.forget(p); dirty.delete(p); }
  for (const t of [...tabs]) if (gone(t.path)) closeTab(t.id);
  S.bookmarks = S.bookmarks.filter((b) => !gone(b)); saveSettings();
  await refreshFiles();
}
async function refreshFiles() {
  const { files } = await api.files();
  setFiles(files);
  renderTree(); renderBookmarks(); updateRight();
}
/** Re-read everything from disk (after rename, git pull, external edits). Unsaved edits win. */
async function reloadFromDisk() {
  const [{ files }, notes] = await Promise.all([api.files(), api.notes()]);
  for (const p of dirty) if (isMd(p) && vault.notes.has(p)) notes[p] = vault.notes.get(p);
  loadAll(files, notes);
  for (const [p, c] of Object.entries(notes)) editor.replace(p, c);
  for (const p of [...textCache.keys()]) if (!dirty.has(p)) textCache.delete(p);
  for (const t of [...tabs]) if (t.path && !fileExists(t.path)) closeTab(t.id);
  renderTabs(); renderTree(); renderBookmarks(); renderTags();
  await renderView();
}

function fileMenuItems(path) {
  const isFolder = vault.folders.has(path);
  return [
    ...(isFolder ? [
      { label: 'New note', icon: 'square-pen', action: () => createNote(path) },
      { label: 'New folder', icon: 'folder-plus', action: () => createFolder(path) },
      'sep',
    ] : [
      { label: 'Open in new tab', icon: 'file-plus', action: () => openFile(path, { newTab: true }) },
      ...(isMd(path) ? [{ label: 'Open in reading view', icon: 'book-open', action: () => openFile(path, { mode: 'preview' }) }] : []),
      { label: S.bookmarks.includes(path) ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', action: () => toggleBookmark(path) },
      'sep',
    ]),
    { label: 'Rename…', icon: 'pencil', action: () => renameFlow(path) },
    ...(!isFolder ? [{ label: 'Make a copy', icon: 'copy', action: () => duplicate(path) }] : []),
    { label: 'Copy path', icon: 'clipboard', action: () => navigator.clipboard.writeText(path).then(() => notice('Path copied')) },
    ...(!isFolder ? [{ label: 'Copy wikilink', icon: 'link', action: () => navigator.clipboard.writeText(`${isMd(path) ? '' : '!'}[[${linkTextFor(path)}]]`).then(() => notice('Link copied')) }] : []),
    ...(!isFolder ? [{ label: 'Open raw file', icon: 'external-link', action: () => window.open(rawUrl(path), '_blank') }] : []),
    'sep',
    { label: 'Delete', icon: 'trash-2', danger: true, action: () => deletePath(path) },
  ];
}
async function duplicate(path) {
  const e = ext(path), base = isMd(path) ? stem(path) : basename(path).replace(/\.[^.]+$/, '');
  const target = uniquePath(dirname(path), base + ' copy', '.' + e);
  await flushAll();
  const blob = await (await fetch(rawUrl(path))).blob();
  await api.write(target, blob, { create: true });
  if (isMd(target)) setNote(target, await blob.text());
  await refreshFiles();
  openFile(target);
}

// attachments (paste / drop)
async function saveAttachments(files, cm, folder = S.attachmentFolder) {
  const links = [];
  for (const f of files) {
    let name = f.name || 'file';
    if (/^image\.(png|jpe?g|gif|webp)$/i.test(name) || !f.name) {
      const d = new Date(), pad = (n) => String(n).padStart(2, '0');
      name = `Pasted image ${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
    }
    const dot = name.lastIndexOf('.');
    const path = uniquePath(folder.replace(/^\/|\/$/g, ''), dot > 0 ? name.slice(0, dot) : name, dot > 0 ? name.slice(dot) : '');
    try {
      await api.write(path, f);
      vault.files.push({ path, type: 'file', size: f.size, mtime: Date.now() });
      if (isMd(path)) setNote(path, await f.text());
      links.push(`${isMd(path) ? '' : '!'}[[${basename(path)}]]`);
    } catch (e) { notice(`Could not save ${name}: ${e.message}`, { error: true }); }
  }
  await refreshFiles();
  if (cm && links.length) { cm.replaceSelection(links.join('\n')); cm.focus(); }
  else if (links.length) notice(`Saved ${links.length} file(s) to ${folder || 'vault root'}`);
}
editor.onFiles = (files, cm) => saveAttachments(files, cm);
editor.onLinkClick = (raw, newTab) => followLink(raw, newTab);

async function followLink(raw, newTab, from = cur()?.path) {
  const { file, sub } = parseLinkText(raw);
  if (!file) return sub && scrollToSub(sub);
  const target = resolve(file, from);
  if (target) return openFile(target, { newTab, sub });
  // unresolved -> create the note (like Obsidian)
  const path = file.includes('/') ? file : (newNoteFolder() ? newNoteFolder() + '/' : '') + file;
  await createNote('', path, '', { newTab });
}

// ---------------- file explorer ----------------
function sortEntries(list) {
  const by = {
    'name-asc': (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    'name-desc': (a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }),
    'mtime-desc': (a, b) => (b.mtime || 0) - (a.mtime || 0), 'mtime-asc': (a, b) => (a.mtime || 0) - (b.mtime || 0),
    'ctime-desc': (a, b) => (b.ctime || 0) - (a.ctime || 0), 'ctime-asc': (a, b) => (a.ctime || 0) - (b.ctime || 0),
  }[S.sort] || ((a, b) => a.name.localeCompare(b.name));
  const folders = list.filter((x) => x.folder).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return folders.concat(list.filter((x) => !x.folder).sort(by));
}
function buildTree() {
  const root = { children: new Map() };
  const node = (path) => {
    let n = root;
    if (!path) return n;
    let acc = '';
    for (const part of path.split('/')) {
      acc = acc ? acc + '/' + part : part;
      if (!n.children.has(part)) n.children.set(part, { name: part, path: acc, folder: true, children: new Map() });
      n = n.children.get(part);
    }
    return n;
  };
  for (const f of vault.folders) node(f);
  for (const f of vault.files) {
    if (basename(f.path).startsWith('.')) continue;
    const parent = node(dirname(f.path));
    parent.children.set(basename(f.path), { name: isMd(f.path) ? stem(f.path) : basename(f.path), path: f.path, folder: false, mtime: f.mtime, ctime: f.ctime });
  }
  return root;
}
function renderTree() {
  const out = [];
  const walk = (n, depth) => {
    for (const c of sortEntries([...n.children.values()])) {
      if (c.folder) {
        const open = expanded.has(c.path);
        out.push(`<div class="tree-item folder${open ? '' : ' collapsed'}" data-path="${esc(c.path)}" data-folder="1" draggable="true" style="--depth:${depth}"><span class="chev">${icon('chevron-down', 14)}</span><span class="name">${esc(c.name)}</span></div>`);
        out.push(`<div class="tree-children${open ? '' : ' collapsed'}" style="--depth:${depth}">`);
        if (open) walk(c, depth + 1);
        out.push('</div>');
      } else {
        const e = ext(c.path);
        out.push(`<div class="tree-item file" data-path="${esc(c.path)}" draggable="true" style="--depth:${depth}"><span class="chev"></span><span class="name">${esc(c.name)}</span>${e && e !== 'md' ? `<span class="ext">${esc(e)}</span>` : ''}</div>`);
      }
    }
  };
  walk(buildTree(), 0);
  $('#file-tree').innerHTML = out.join('') || '<div class="empty-msg">This vault is empty.</div>';
  highlightTree();
}
function highlightTree() {
  const p = cur()?.path;
  $$('#file-tree .tree-item.is-active').forEach((e) => e.classList.remove('is-active'));
  if (!p) return;
  const el = $(`#file-tree .tree-item[data-path="${CSS.escape(p)}"]`);
  if (el) { el.classList.add('is-active'); }
}
function revealInTree(path) {
  addFolders(dirname(path));
  renderTree();
  $(`#file-tree .tree-item[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' });
}
function bindTree() {
  const tree = $('#file-tree');
  tree.addEventListener('click', (e) => {
    const it = e.target.closest('.tree-item');
    if (!it) return;
    const p = it.dataset.path;
    if (it.dataset.folder) { expanded.has(p) ? expanded.delete(p) : expanded.add(p); saveExpanded(); renderTree(); }
    else openFile(p, { newTab: e.ctrlKey || e.metaKey });
  });
  tree.addEventListener('auxclick', (e) => { const it = e.target.closest('.tree-item.file'); if (it && e.button === 1) openFile(it.dataset.path, { newTab: true }); });
  tree.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const it = e.target.closest('.tree-item');
    if (it) menu(e.clientX, e.clientY, fileMenuItems(it.dataset.path));
    else menu(e.clientX, e.clientY, [{ label: 'New note', icon: 'square-pen', action: () => createNote('') }, { label: 'New folder', icon: 'folder-plus', action: () => createFolder('') }]);
  });
  // drag & drop: move files/folders, or import files from the OS
  let dragPath = null;
  tree.addEventListener('dragstart', (e) => {
    const it = e.target.closest('.tree-item'); if (!it) return;
    dragPath = it.dataset.path;
    e.dataTransfer.setData('text/x-mdvault-path', dragPath);
    e.dataTransfer.setData('text/plain', `[[${linkTextFor(dragPath)}]]`);
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  tree.addEventListener('dragend', () => { dragPath = null; });
  const targetFolder = (e) => { const it = e.target.closest('.tree-item'); if (!it) return ''; return it.dataset.folder ? it.dataset.path : dirname(it.dataset.path); };
  tree.addEventListener('dragover', (e) => {
    e.preventDefault();
    $$('.drop-target', tree).forEach((x) => x.classList.remove('drop-target'));
    const f = targetFolder(e);
    if (f) $(`.tree-item[data-path="${CSS.escape(f)}"]`, tree)?.classList.add('drop-target');
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) $$('.drop-target', tree).forEach((x) => x.classList.remove('drop-target')); });
  tree.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    $$('.drop-target', tree).forEach((x) => x.classList.remove('drop-target'));
    const folder = targetFolder(e);
    if (e.dataTransfer.files.length) return saveAttachments([...e.dataTransfer.files], null, folder);
    const src = dragPath || e.dataTransfer.getData('text/x-mdvault-path');
    if (!src || dirname(src) === folder || folder === src || folder.startsWith(src + '/')) return;
    await renamePath(src, (folder ? folder + '/' : '') + basename(src));
  });
  $('#sort-btn').addEventListener('click', (e) => {
    const opts = [['name-asc', 'File name (A to Z)'], ['name-desc', 'File name (Z to A)'], ['mtime-desc', 'Modified time (new to old)'], ['mtime-asc', 'Modified time (old to new)'], ['ctime-desc', 'Created time (new to old)'], ['ctime-asc', 'Created time (old to new)']];
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left, r.bottom + 4, opts.map(([k, l]) => ({ label: (S.sort === k ? '✓ ' : ' ') + l, action: () => { S.sort = k; saveSettings(); renderTree(); } })));
  });
}

// ---------------- left panes: search, tags, bookmarks ----------------
let searchTimer = null;
function runSearch() {
  const q = $('#search-input').value.trim();
  const box = $('#search-results'), meta = $('#search-meta');
  if (!q) { box.innerHTML = ''; meta.textContent = ''; return; }
  const { results, terms } = search(q);
  meta.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
  const hl = (text) => {
    let s = esc(text.length > 220 ? text.slice(0, 220) + '…' : text);
    for (const t of terms) if (t) s = s.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    return s;
  };
  box.innerHTML = results.slice(0, 200).map((r) => `<div class="result-file"><div class="result-title" data-path="${esc(r.path)}"><span>${hl(stem(r.path))}</span><span class="count">${r.matches.length || ''}</span></div>
    ${r.matches.slice(0, 6).map((m) => `<div class="result-match" data-path="${esc(r.path)}" data-line="${m.line}">${hl(m.text.trim())}</div>`).join('')}</div>`).join('');
}
function bindSearch() {
  $('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
  $('#search-results').addEventListener('click', (e) => {
    const m = e.target.closest('[data-path]'); if (!m) return;
    openFile(m.dataset.path, { line: m.dataset.line != null ? +m.dataset.line : undefined, newTab: e.ctrlKey || e.metaKey });
  });
}
function openSearch(q = null) {
  showLeftPane('search');
  const i = $('#search-input');
  if (q != null) { i.value = q; runSearch(); }
  i.focus(); i.select();
}
function renderTags() {
  const counts = allTags();
  const tree = new Map();
  for (const [t, n] of counts) {
    const parts = t.split('/');
    let level = tree, acc = '';
    parts.forEach((p, i) => {
      acc = acc ? acc + '/' + p : p;
      if (!level.has(p)) level.set(p, { tag: acc, count: 0, children: new Map() });
      const node = level.get(p);
      node.count += n;
      level = node.children;
    });
  }
  const out = [];
  const walk = (m, d) => { for (const [, n] of [...m].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) { out.push(`<div class="tag-row" data-tag="${esc(n.tag)}" style="--depth:${d}"><span>#${esc(n.tag.split('/').pop())}</span><span class="count">${n.count}</span></div>`); walk(n.children, d + 1); } };
  walk(tree, 0);
  $('#tag-list').innerHTML = out.join('') || '<div class="empty-msg">No tags yet. Add #tags to your notes.</div>';
}
function toggleBookmark(path = cur()?.path) {
  if (!path) return;
  S.bookmarks = S.bookmarks.includes(path) ? S.bookmarks.filter((b) => b !== path) : S.bookmarks.concat(path);
  saveSettings(); renderBookmarks(); const t = cur(); if (t) setHeaderButtons(t);
}
function renderBookmarks() {
  $('#bookmark-list').innerHTML = S.bookmarks.length ? S.bookmarks.map((b) => `<div class="link-row${fileExists(b) ? '' : ' unresolved'}" data-path="${esc(b)}">${icon('bookmark', 14)}<span>${esc(isMd(b) ? stem(b) : basename(b))}</span></div>`).join('')
    : '<div class="empty-msg">No bookmarks. Use the bookmark icon in the note header.</div>';
}
function showLeftPane(name) {
  if (S.leftCollapsed) { S.leftCollapsed = false; applyAppearance(); }
  S.leftPane = name; saveSettings();
  $$('#left .side-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.pane === name));
  $$('#left .pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === name));
  if (name === 'tags') renderTags();
  if (name === 'bookmarks') renderBookmarks();
}
function showRightPane(name) {
  S.rightPane = name; saveSettings();
  $$('#right .side-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.pane === name));
  $$('#right .pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === name));
  updateRight();
}

// ---------------- right sidebar ----------------
let rightTimer = null;
function updateRight() { clearTimeout(rightTimer); rightTimer = setTimeout(renderRight, 60); }
function lineContext(path, line) {
  const l = (vault.notes.get(path) || '').split('\n')[line] || '';
  return esc(l.trim().slice(0, 240)).replace(/\[\[([^\]]+)\]\]/g, '<mark>[[$1]]</mark>');
}
function renderRight() {
  if (S.rightCollapsed) return;
  const t = cur();
  const path = t?.path;
  const pane = S.rightPane;
  if (pane === 'backlinks') {
    const el = $('#backlinks');
    if (!path) { el.innerHTML = '<div class="empty-msg">No file open.</div>'; return; }
    const bl = backlinks(path);
    el.innerHTML = `<div class="pane-heading"><span>Linked mentions</span><span>${bl.length}</span></div>` + (bl.length ? bl.map((b) => `<div class="link-row" data-path="${esc(b.path)}">${icon('file-text', 14)}<span>${esc(stem(b.path))}</span></div>${b.hits.slice(0, 5).map((h) => `<div class="backlink-ctx" data-path="${esc(b.path)}" data-line="${h.line}">${lineContext(b.path, h.line)}</div>`).join('')}`).join('') : '<div class="empty-msg">No backlinks found.</div>')
      + unlinkedMentions(path);
  } else if (pane === 'outgoing') {
    const el = $('#outgoing');
    if (!path || !isMd(path)) { el.innerHTML = '<div class="empty-msg">No note open.</div>'; return; }
    const links = resolvedLinks(path).filter((l) => l.file);
    const seen = new Set(), res = [], unres = [];
    for (const l of links) { const k = l.resolved || 'u:' + l.file.toLowerCase(); if (seen.has(k)) continue; seen.add(k); (l.resolved ? res : unres).push(l); }
    el.innerHTML = `<div class="pane-heading"><span>Links</span><span>${res.length}</span></div>` + (res.map((l) => `<div class="link-row" data-path="${esc(l.resolved)}">${icon(isMd(l.resolved) ? 'file-text' : 'paperclip', 14)}<span>${esc(isMd(l.resolved) ? stem(l.resolved) : basename(l.resolved))}</span></div>`).join('') || '<div class="empty-msg">No outgoing links.</div>')
      + (unres.length ? `<div class="pane-heading"><span>Unresolved</span><span>${unres.length}</span></div>` + unres.map((l) => `<div class="link-row unresolved" data-create="${esc(l.file)}">${icon('file-plus', 14)}<span>${esc(l.file)}</span></div>`).join('') : '');
  } else if (pane === 'outline') {
    const el = $('#outline');
    const hs = path ? vault.meta.get(path)?.headings || [] : [];
    el.innerHTML = hs.length ? hs.map((h) => `<div class="outline-item" style="--lvl:${h.level}" data-line="${h.line}" data-heading="${esc(h.text)}">${esc(h.text)}</div>`).join('') : '<div class="empty-msg">No headings in this note.</div>';
  } else if (pane === 'localgraph') {
    if (!localGraph) localGraph = new ForceGraph($('#local-graph-canvas'), { local: true, onOpen: (n, e) => graphOpen(n, e) });
    localGraph.resize();
    localGraph.setData(path && isMd(path) ? buildGraph({ center: path, depth: 1, tags: S.graphTags, attachments: true, orphans: true }) : { nodes: [], links: [] }, path);
  } else if (pane === 'properties') renderFileInfo(path);
}
function unlinkedMentions(path) {
  if (!isMd(path)) return '';
  const name = stem(path);
  if (name.length < 3) return '';
  const re = new RegExp(`(^|[^\\p{L}\\p{N}[|#])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}\\]])`, 'iu');
  const linked = new Set(backlinks(path).map((b) => b.path));
  const out = [];
  for (const [p, c] of vault.notes) {
    if (p === path || linked.has(p)) continue;
    const lines = c.split('\n');
    const i = lines.findIndex((l) => re.test(l.replace(/\[\[[^\]]*\]\]/g, '')));
    if (i >= 0) out.push({ p, i, text: lines[i] });
    if (out.length > 30) break;
  }
  if (!out.length) return '';
  return `<div class="pane-heading"><span>Unlinked mentions</span><span>${out.length}</span></div>` + out.map((o) => `<div class="link-row" data-path="${esc(o.p)}">${icon('file', 14)}<span>${esc(stem(o.p))}</span></div><div class="backlink-ctx" data-path="${esc(o.p)}" data-line="${o.i}">${esc(o.text.trim().slice(0, 200))}</div>`).join('');
}
async function renderFileInfo(path) {
  const el = $('#file-info');
  if (!path) { el.innerHTML = '<div class="empty-msg">No file open.</div>'; return; }
  const f = vault.files.find((x) => x.path === path);
  const content = vault.notes.get(path);
  const fm = content != null ? splitFrontmatter(content).fm : null;
  const words = content != null ? (splitFrontmatter(content).body.match(/\S+/g) || []).length : null;
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  el.innerHTML = `<div class="pane-heading"><span>File</span></div><dl class="kv"><dt>Path</dt><dd>${esc(path)}</dd><dt>Size</dt><dd>${f ? (f.size / 1024).toFixed(1) + ' KB' : '—'}</dd><dt>Modified</dt><dd>${fmt(f?.mtime)}</dd><dt>Created</dt><dd>${fmt(f?.ctime)}</dd>${words != null ? `<dt>Words</dt><dd>${words}</dd>` : ''}${isMd(path) ? `<dt>Tags</dt><dd>${(vault.meta.get(path)?.tags || []).map((t) => '#' + esc(t)).join(' ') || '—'}</dd>` : ''}</dl>`
    + (fm && Object.keys(fm).length ? `<div class="pane-heading"><span>Properties</span></div><dl class="kv">${Object.entries(fm).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join(', ') : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>` : '')
    + `<div class="pane-heading"><span>Git history</span></div><div id="file-history"><div class="empty-msg">Loading…</div></div>`;
  try {
    const log = await api.gitLog(path);
    const h = $('#file-history');
    if (h) h.innerHTML = log.length ? log.map((c) => `<div class="history-row"><b>${esc(c.message)}</b><br>${esc(new Date(c.date).toLocaleString())} · <code>${esc(c.hash)}</code></div>`).join('') : '<div class="empty-msg">No commits for this file yet.</div>';
  } catch { const h = $('#file-history'); if (h) h.innerHTML = '<div class="empty-msg">Not a git repository.</div>'; }
}
function bindRight() {
  $('#right').addEventListener('click', (e) => {
    const row = e.target.closest('[data-path], [data-create], .outline-item');
    if (!row) return;
    if (row.classList.contains('outline-item')) { const t = cur(); if (t?.mode === 'source') goToLine(+row.dataset.line); else scrollToSub(row.dataset.heading); return; }
    if (row.dataset.create) return followLink(row.dataset.create, e.ctrlKey || e.metaKey);
    openFile(row.dataset.path, { line: row.dataset.line != null ? +row.dataset.line : undefined, newTab: e.ctrlKey || e.metaKey });
  });
}

// ---------------- status bar ----------------
function updateStatus() {
  const t = cur();
  const p = t?.path;
  if (p && isMd(p)) {
    const n = backlinks(p).length;
    $('#st-backlinks').textContent = `${n} backlink${n === 1 ? '' : 's'}`;
    const body = splitFrontmatter(vault.notes.get(p) || '').body;
    const sel = editor.path === p && editor.cm.somethingSelected() ? editor.cm.getSelection() : null;
    const txt = sel ?? body;
    $('#st-words').textContent = `${(txt.match(/\S+/g) || []).length.toLocaleString()} words  ${txt.length.toLocaleString()} characters`;
  } else { $('#st-backlinks').textContent = ''; $('#st-words').textContent = ''; }
}

// ---------------- reading-view interactions ----------------
function bindPreview() {
  const host = $('#preview-host');
  const root = createPreviewRoot(host);
  root.addEventListener('click', async (e) => {
    const a = e.target.closest('a');
    const t = cur();
    if (a?.classList.contains('internal-link')) {
      e.preventDefault();
      const href = a.dataset.href || '';
      const path = a.dataset.path;
      const newTab = e.ctrlKey || e.metaKey || e.button === 1;
      if (path) return openFile(path, { sub: a.dataset.sub || href.split('#')[1], newTab });
      return followLink(href, newTab);
    }
    if (a?.classList.contains('tag')) { e.preventDefault(); return openSearch(`tag:#${a.dataset.tag}`); }
    if (a && (a.getAttribute('href') || '').startsWith('#')) {
      e.preventDefault();
      const id = decodeURIComponent(a.getAttribute('href').slice(1));
      const target = root.getElementById(id) || root.querySelector(`[id="${CSS.escape(id)}"]`);
      if (target) { target.scrollIntoView({ block: 'center' }); flash(target); }
      return;
    }
    const cb = e.target.closest('input.task-list-item-checkbox');
    if (cb && t?.path && isMd(t.path)) {
      const line = +cb.dataset.line;
      editor.open(t.path, vault.notes.get(t.path));
      toggleTask(editor.cm, line);
      const y = previewScroller().scrollTop;
      await renderPreview(t);
      previewScroller().scrollTop = y;
      return;
    }
    const ct = e.target.closest('.callout.is-collapsible > .callout-title');
    if (ct) { ct.parentElement.classList.toggle('is-collapsed'); return; }
    const copy = e.target.closest('.copy-code');
    if (copy) { navigator.clipboard.writeText(decodeURIComponent(copy.dataset.src)); copy.textContent = 'Copied!'; setTimeout(() => (copy.textContent = 'Copy'), 1200); }
  });
  root.addEventListener('auxclick', (e) => { const a = e.target.closest('a.internal-link'); if (a && e.button === 1) { e.preventDefault(); a.dataset.path ? openFile(a.dataset.path, { newTab: true }) : followLink(a.dataset.href, true); } });
  root.addEventListener('dblclick', (e) => {
    // double-click a rendered block to jump to its source line (Obsidian-ish)
    if (e.target.closest('a, input, .html-embed, .mermaid-block, button')) return;
    const el = e.target.closest('[data-line]');
    const t = cur();
    if (!el || !t || t.type !== 'note' || !e.altKey) return;
    t.mode = 'source'; renderView().then(() => editor.goToLine(+el.dataset.line));
  });
  root.addEventListener('mouseover', (e) => { const a = e.target.closest('a.internal-link'); if (a) schedulePopover(a); });
  root.addEventListener('mouseout', (e) => { if (e.target.closest('a.internal-link')) leavePopover(); });
  previewRoot = root;
  const pop = $('#hover-popover');
  pop.addEventListener('mouseenter', () => clearTimeout(popHideTimer));
  pop.addEventListener('mouseleave', leavePopover);
  pop.addEventListener('click', (e) => {
    const a = e.composedPath().find((n) => n.classList?.contains('internal-link'));
    if (!a) return;
    e.preventDefault(); hidePopover();
    a.dataset.path ? openFile(a.dataset.path, { sub: a.dataset.sub, newTab: e.ctrlKey || e.metaKey }) : followLink(a.dataset.href, e.ctrlKey || e.metaKey);
  });
}

// hover previews for internal links
let popTimer = null, popHideTimer = null, popFor = null;
function schedulePopover(a) {
  clearTimeout(popHideTimer);
  if (popFor === a) return;
  clearTimeout(popTimer);
  popTimer = setTimeout(() => showPopover(a), 450);
}
function leavePopover() { clearTimeout(popTimer); popHideTimer = setTimeout(hidePopover, 300); }
function hidePopover() { clearTimeout(popTimer); const p = $('#hover-popover'); p.classList.remove('show'); popFor = null; }
async function showPopover(a) {
  const path = a.dataset.path || resolve(parseLinkText(a.dataset.href || '').file, cur()?.path);
  if (!path || !isMd(path) || path === cur()?.path && !a.dataset.sub) return;
  popFor = a;
  const pop = $('#hover-popover');
  pop.innerHTML = '<div class="pop-host"></div>';
  const root = createPreviewRoot(pop.firstChild);
  const r = a.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - 480) + 'px';
  pop.style.top = (r.bottom + 360 > innerHeight ? Math.max(8, r.top - 370) : r.bottom + 6) + 'px';
  pop.classList.add('show');
  const sub = a.dataset.sub;
  const src = vault.notes.get(path) || '';
  await renderInto(root.querySelector('.content'), src, path);
  if (sub) { const want = normHeading(sub); const h = [...root.querySelectorAll('[data-heading]')].find((x) => normHeading(x.dataset.heading) === want); if (h) pop.scrollTop = h.offsetTop - 10; }
}

// full-screen view of an HTML embed
hooks.fullscreen = ({ html, title, baseDir }) => {
  const { el } = modal('embed-full', `<div class="embed-full-head"><span>${esc(title)}</span><span>Esc to close</span></div><div class="embed-full-body"></div>`);
  el.querySelector('.embed-full-body').appendChild(fullscreenDoc(html, baseDir));
};
hooks.openRaw = (path) => openFile(path, { newTab: true, mode: 'source' });

// ---------------- graph ----------------
function openGraph(newT = false) {
  let t = tabs.find((x) => x.type === 'graph');
  if (!t) { t = newT || cur()?.type !== 'empty' ? newTab(null) : cur(); t.type = 'graph'; t.path = null; }
  activate(t.id);
}
function graphOpen(n, e) {
  if (n.kind === 'tag') return openSearch(`tag:#${n.label.slice(1)}`);
  if (n.kind === 'unresolved') return followLink(n.label, true);
  openFile(n.id, { newTab: e.ctrlKey || e.metaKey || cur()?.type === 'graph' });
}
function refreshGraph() {
  if (!graph) graph = new ForceGraph($('#graph-canvas'), { onOpen: (n, e) => graphOpen(n, e) });
  graph.resize();
  graph.setData(buildGraph({ tags: S.graphTags, orphans: S.graphOrphans, attachments: S.graphAttach, filter: $('#graph-filter').value }), null);
}
function bindGraphControls() {
  $('#graph-tags').checked = S.graphTags; $('#graph-orphans').checked = S.graphOrphans; $('#graph-attach').checked = S.graphAttach;
  for (const [id, key] of [['#graph-tags', 'graphTags'], ['#graph-orphans', 'graphOrphans'], ['#graph-attach', 'graphAttach']])
    $(id).addEventListener('change', (e) => { S[key] = e.target.checked; saveSettings(); refreshGraph(); });
  let ft; $('#graph-filter').addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(refreshGraph, 200); });
}

// ---------------- quick switcher & command palette ----------------
function quickSwitcher() {
  suggest({
    placeholder: 'Find or create a note…',
    footer: '<span>↑↓ navigate</span><span>↵ open</span><span>ctrl ↵ new tab</span><span>shift ↵ create</span><span>esc dismiss</span>',
    getItems(q) {
      q = q.trim();
      if (!q) {
        const recent = [...new Set(tabs.flatMap((t) => t.hist.slice().reverse()))].filter(fileExists);
        const rest = [...vault.files].sort((a, b) => b.mtime - a.mtime).map((f) => f.path).filter((p) => !recent.includes(p) && !basename(p).startsWith('.'));
        return recent.concat(rest).slice(0, 60).map((p) => ({ html: esc(isMd(p) ? stem(p) : basename(p)), sub: esc(dirname(p)), value: p }));
      }
      const items = [];
      for (const f of vault.files) {
        if (basename(f.path).startsWith('.')) continue;
        const name = isMd(f.path) ? stem(f.path) : basename(f.path);
        const a = fuzzy(q, name), b = !a && fuzzy(q, f.path);
        if (a) items.push({ score: a.score + (isMd(f.path) ? 3 : 0), html: highlightIdx(name, a.idx), sub: esc(dirname(f.path)), value: f.path });
        else if (b) items.push({ score: b.score - 50, html: esc(name), sub: highlightIdx(f.path, b.idx), value: f.path });
        for (const al of vault.meta.get(f.path)?.aliases || []) { const r = fuzzy(q, al); if (r) items.push({ score: r.score - 2, html: highlightIdx(al, r.idx) + ` <span style="color:var(--text-faint)">→ ${esc(name)}</span>`, sub: esc(dirname(f.path)), value: f.path }); }
      }
      items.sort((x, y) => y.score - x.score);
      const out = items.slice(0, 60);
      if (!items.some((i) => stem(i.value).toLowerCase() === q.toLowerCase())) out.push({ html: `Create new note: <b>${esc(q)}</b>`, key: 'shift ↵', create: q });
      return out;
    },
    onChoose(it, e, q) {
      if (e?.shiftKey && q.trim()) return createNote(newNoteFolder(), q.trim(), '', { newTab: e.ctrlKey });
      if (!it) return;
      if (it.create) return createNote(newNoteFolder(), it.create, '', { newTab: e?.ctrlKey });
      openFile(it.value, { newTab: e?.ctrlKey || e?.metaKey });
    },
  });
}
const commands = [
  { id: 'quick-switcher', name: 'Quick switcher: Open', key: 'Ctrl+O', run: quickSwitcher },
  { id: 'palette', name: 'Command palette: Open', key: 'Ctrl+P', run: () => palette() },
  { id: 'new-note', name: 'Create new note', key: 'Alt+N', run: () => createNote() },
  { id: 'new-note-tab', name: 'Create new note in new tab', run: () => createNote(newNoteFolder(), 'Untitled', '', { newTab: true }) },
  { id: 'new-folder', name: 'Create new folder', run: () => createFolder(newNoteFolder()) },
  { id: 'new-tab', name: 'New tab', key: 'Alt+T', run: () => newTab() },
  { id: 'close-tab', name: 'Close current tab', key: 'Alt+W', run: () => closeTab() },
  { id: 'reopen-tab', name: 'Reopen closed tab', key: 'Alt+Shift+T', run: reopenClosed },
  { id: 'next-tab', name: 'Go to next tab', key: 'Ctrl+Alt+→', run: () => cycleTab(1) },
  { id: 'prev-tab', name: 'Go to previous tab', key: 'Ctrl+Alt+←', run: () => cycleTab(-1) },
  { id: 'back', name: 'Navigate back', key: 'Alt+←', run: () => navigate(-1) },
  { id: 'forward', name: 'Navigate forward', key: 'Alt+→', run: () => navigate(1) },
  { id: 'toggle-mode', name: 'Toggle reading view', key: 'Ctrl+E', run: () => { const t = cur(); if (t) setMode(t.mode === 'preview' ? 'source' : 'preview'); } },
  { id: 'toggle-split', name: 'Toggle split view (editor + preview)', key: 'Ctrl+\\', run: () => { const t = cur(); if (t) setMode(t.mode === 'split' ? 'source' : 'split'); } },
  { id: 'search', name: 'Search: Search in all files', key: 'Ctrl+Shift+F', run: () => openSearch() },
  { id: 'graph', name: 'Graph view: Open graph view', key: 'Ctrl+G', run: () => openGraph() },
  { id: 'local-graph', name: 'Graph view: Open local graph', run: () => { if (S.rightCollapsed) toggleRight(); showRightPane('localgraph'); } },
  { id: 'daily-note', name: "Daily notes: Open today's daily note", key: 'Alt+D', run: () => dailyNote() },
  { id: 'toggle-left', name: 'Toggle left sidebar', run: () => toggleLeft() },
  { id: 'toggle-right', name: 'Toggle right sidebar', run: () => toggleRight() },
  { id: 'backlinks', name: 'Backlinks: Show backlinks', run: () => { if (S.rightCollapsed) toggleRight(); showRightPane('backlinks'); } },
  { id: 'outline', name: 'Outline: Show outline', run: () => { if (S.rightCollapsed) toggleRight(); showRightPane('outline'); } },
  { id: 'tags', name: 'Tags: Show tags', run: () => showLeftPane('tags') },
  { id: 'files', name: 'Files: Show file explorer', key: 'Ctrl+Shift+E', run: () => showLeftPane('files') },
  { id: 'reveal', name: 'Files: Reveal current file in navigation', run: () => { const p = cur()?.path; if (p) { showLeftPane('files'); revealInTree(p); } } },
  { id: 'collapse-all', name: 'Files: Collapse all folders', run: () => { expanded.clear(); saveExpanded(); renderTree(); } },
  { id: 'bookmark', name: 'Bookmarks: Bookmark current file', run: () => toggleBookmark() },
  { id: 'rename', name: 'Rename file', key: 'F2', run: () => { const p = cur()?.path; if (p) renameFlow(p); } },
  { id: 'delete', name: 'Delete current file', run: () => { const p = cur()?.path; if (p) deletePath(p); } },
  { id: 'duplicate', name: 'Make a copy of current file', run: () => { const p = cur()?.path; if (p) duplicate(p); } },
  { id: 'save', name: 'Save current file', key: 'Ctrl+S', run: () => { const p = cur()?.path; if (p) { dirty.add(p); save(p).then(() => notice('Saved', { timeout: 1200 })); } } },
  { id: 'insert-html', name: 'Insert HTML embed block', run: () => insertSnippet('```html-embed\n<style>\n  .box { border: 2px solid #10b981; border-radius: 8px; padding: 10px 14px; display: inline-block; }\n</style>\n<div class="box">Hello from HTML</div>\n```\n') },
  { id: 'insert-html-file', name: 'Insert embed of an HTML/image file…', run: () => pickFileToEmbed() },
  { id: 'new-html', name: 'Create new HTML diagram file', run: () => newHtmlFile() },
  { id: 'insert-callout', name: 'Insert callout', run: () => insertSnippet('> [!note] Title\n> Content\n') },
  { id: 'insert-mermaid', name: 'Insert Mermaid diagram', run: () => insertSnippet('```mermaid\nflowchart LR\n  A --> B\n```\n') },
  { id: 'insert-math', name: 'Insert math block', run: () => insertSnippet('$$\n\n$$\n', 1) },
  { id: 'insert-table', name: 'Insert table', run: () => insertSnippet('| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |\n') },
  { id: 'insert-date', name: 'Insert current date', run: () => insertSnippet(formatDate(new Date(), 'YYYY-MM-DD')) },
  { id: 'insert-template', name: 'Templates: Insert template…', run: () => insertTemplate() },
  { id: 'toggle-task', name: 'Toggle checkbox status', key: 'Ctrl+Enter', run: () => { if (editor.path) toggleTask(editor.cm, editor.cm.getCursor().line); } },
  { id: 'find', name: 'Search current file', key: 'Ctrl+F', run: () => { const t = cur(); if (t?.mode === 'preview') setMode('source'); setTimeout(() => editor.cm.execCommand('findPersistent'), 50); } },
  { id: 'toggle-theme', name: 'Toggle light/dark theme', run: () => { S.theme = S.theme === 'light' ? 'dark' : 'light'; saveSettings(); applyAppearance(); renderView(); } },
  { id: 'sync', name: 'GitHub: Sync now (commit, pull, push)', key: 'Ctrl+Shift+S', run: () => syncNow() },
  { id: 'git-setup', name: 'GitHub: Connect vault to a repository', run: () => openSettings('sync') },
  { id: 'reload', name: 'Reload vault from disk', run: () => reloadFromDisk().then(() => notice('Vault reloaded')) },
  { id: 'settings', name: 'Open settings', key: 'Ctrl+,', run: () => openSettings() },
  { id: 'shortcuts', name: 'Show keyboard shortcuts', run: () => openSettings('hotkeys') },
];
function runCommand(id) { const c = commands.find((x) => x.id === id); if (c) c.run(); }
let recentCmds = []; try { recentCmds = JSON.parse(localStorage.getItem('mdvault.recentCmds') || '[]'); } catch {}
function palette() {
  suggest({
    placeholder: 'Select a command…',
    footer: '<span>↑↓ navigate</span><span>↵ use</span><span>esc dismiss</span>',
    getItems(q) {
      const list = commands.filter((c) => c.id !== 'palette');
      if (!q.trim()) return [...list].sort((a, b) => (recentCmds.indexOf(a.id) + 1 || 999) - (recentCmds.indexOf(b.id) + 1 || 999)).map((c) => ({ html: esc(c.name), key: c.key, value: c.id }));
      return list.map((c) => ({ c, f: fuzzy(q, c.name) })).filter((x) => x.f).sort((a, b) => b.f.score - a.f.score).map(({ c, f }) => ({ html: highlightIdx(c.name, f.idx), key: c.key, value: c.id }));
    },
    onChoose(it) {
      if (!it) return;
      recentCmds = [it.value, ...recentCmds.filter((x) => x !== it.value)].slice(0, 8);
      try { localStorage.setItem('mdvault.recentCmds', JSON.stringify(recentCmds)); } catch {}
      setTimeout(() => runCommand(it.value), 0);
    },
  });
}
function cycleTab(d) { const i = tabs.findIndex((t) => t.id === activeId); activate(tabs[(i + d + tabs.length) % tabs.length].id); }
function toggleLeft() { S.leftCollapsed = !S.leftCollapsed; saveSettings(); applyAppearance(); }
function toggleRight() { S.rightCollapsed = !S.rightCollapsed; saveSettings(); applyAppearance(); updateRight(); }

function ensureEditing() {
  const t = cur();
  if (!t || (t.type !== 'note' && t.type !== 'text')) { notice('Open a note first'); return false; }
  if (t.mode === 'preview') { t.mode = 'source'; renderView(); }
  return true;
}
function insertSnippet(text, cursorBackLines = 0) {
  if (!ensureEditing()) return;
  setTimeout(() => {
    const cm = editor.cm;
    const c = cm.getCursor();
    const needNl = c.ch > 0 && text.includes('\n') ? '\n' : '';
    cm.replaceSelection(needNl + text);
    if (cursorBackLines) { const p = cm.getCursor(); cm.setCursor({ line: p.line - cursorBackLines - 1, ch: 0 }); }
    cm.focus();
  }, 30);
}
function pickFileToEmbed() {
  if (!ensureEditing()) return;
  suggest({
    placeholder: 'Embed which file? (html, images, notes…)',
    getItems: (q) => vault.files.filter((f) => !basename(f.path).startsWith('.')).map((f) => ({ f, r: fuzzy(q, f.path) })).filter((x) => x.r).sort((a, b) => (ext(b.f.path) === 'html') - (ext(a.f.path) === 'html') || b.r.score - a.r.score).slice(0, 50).map(({ f, r }) => ({ html: highlightIdx(f.path, r.idx), value: f.path, key: ext(f.path) })),
    onChoose: (it) => it && insertSnippet(`![[${linkTextFor(it.value)}]]`),
  });
}
async function newHtmlFile() {
  const name = await prompt('New HTML diagram file', 'Diagram', { cta: 'Create' });
  if (!name) return;
  const path = uniquePath(dirname(cur()?.path || '') || newNoteFolder(), name, '.html');
  const tpl = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<style>\n  body { font: 14px system-ui, sans-serif; padding: 16px; }\n  .flow { display: flex; gap: 24px; align-items: center; }\n  .blk { border: 2px solid #10b981; border-radius: 10px; padding: 12px 18px; }\n</style>\n</head>\n<body>\n  <div class="flow">\n    <div class="blk">Block A</div> ➜ <div class="blk">Block B</div>\n  </div>\n</body>\n</html>\n`;
  await api.write(path, tpl, { create: true });
  await refreshFiles();
  const from = cur();
  if (from?.type === 'note' && from.mode !== 'preview' && editor.path === from.path) { editor.cm.replaceSelection(`![[${basename(path)}]]`); }
  openFile(path, { newTab: true, mode: 'split' });
}
async function insertTemplate() {
  const folder = (S.templatesFolder || 'Templates').toLowerCase();
  const list = vault.files.filter((f) => isMd(f.path) && f.path.toLowerCase().startsWith(folder + '/'));
  if (!list.length) return notice(`Put template notes in a "${S.templatesFolder || 'Templates'}" folder first.`);
  suggest({
    placeholder: 'Choose a template…',
    getItems: (q) => list.map((f) => ({ f, r: fuzzy(q, stem(f.path)) })).filter((x) => x.r).map(({ f, r }) => ({ html: highlightIdx(stem(f.path), r.idx), value: f.path })),
    onChoose: (it) => it && insertSnippet(applyTemplate(vault.notes.get(it.value) || '', stem(cur()?.path || ''))),
  });
}
function applyTemplate(src, title) {
  const now = new Date();
  return src.replace(/\{\{\s*(date|time|title)(?::([^}]+))?\s*\}\}/g, (_, k, f) => (k === 'title' ? title : formatDate(now, f || (k === 'date' ? 'YYYY-MM-DD' : 'HH:mm'))));
}
function formatDate(d, f) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const map = { YYYY: d.getFullYear(), YY: pad(d.getFullYear() % 100), MMMM: months[d.getMonth()], MMM: months[d.getMonth()].slice(0, 3), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1, DD: pad(d.getDate()), D: d.getDate(), dddd: days[d.getDay()], ddd: days[d.getDay()].slice(0, 3), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
  return f.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|ss/g, (t) => map[t]);
}
async function dailyNote() {
  const name = formatDate(new Date(), S.dailyFormat || 'YYYY-MM-DD');
  const folder = S.dailyFolder.replace(/^\/|\/$/g, '');
  const path = (folder ? folder + '/' : '') + name + '.md';
  if (fileExists(path)) return openFile(path);
  let content = '';
  if (S.dailyTemplate) { const tp = resolve(S.dailyTemplate); if (tp) content = applyTemplate(await getContent(tp), name); }
  await createNote('', path, content, { mode: 'source' });
}

// ---------------- GitHub sync ----------------
let gitTimer = null, autoTimer = null;
function scheduleGitRefresh() { clearTimeout(gitTimer); gitTimer = setTimeout(refreshGit, 1500); }
async function refreshGit() {
  try { git.status = await api.gitStatus(); } catch { git.status = null; }
  renderGitStatus();
}
function renderGitStatus() {
  const b = $('#st-sync'), s = git.status;
  b.classList.remove('warn', 'error', 'busy');
  let ic = 'cloud', text = '', title = '';
  if (git.busy) { ic = 'refresh-cw'; text = 'Syncing…'; b.classList.add('busy'); }
  else if (!s || !s.repo) { ic = 'cloud-off'; text = 'Not synced'; title = 'Vault is not connected to GitHub. Click to set up.'; }
  else if (s.conflicts?.length || s.merging) { ic = 'triangle-alert'; text = 'Conflict'; b.classList.add('error'); title = 'Merge conflict in: ' + s.conflicts.join(', '); }
  else {
    const n = s.changes.length;
    if (!s.remote) { ic = 'git-commit-horizontal'; text = n ? `${n} uncommitted` : 'Local git only'; title = 'No GitHub remote configured'; }
    else if (n || s.ahead) { ic = 'cloud-upload'; text = n ? `${n} change${n > 1 ? 's' : ''}` : `${s.ahead} to push`; b.classList.add('warn'); }
    else if (s.behind) { ic = 'cloud-download'; text = `${s.behind} to pull`; b.classList.add('warn'); }
    else { ic = 'cloud-check'; text = 'Synced'; }
    title = title || `${s.remote}  (${s.branch})${s.lastCommit ? `\nLast commit: ${s.lastCommit.message} — ${new Date(s.lastCommit.date).toLocaleString()}` : ''}\nClick to sync`;
  }
  b.innerHTML = `${icon(ic, 13)}<span>${esc(text)}</span>`;
  b.title = title;
  $('.ribbon-btn[data-cmd=sync]')?.classList.toggle('spinning', git.busy);
}
async function syncNow({ quiet = false } = {}) {
  if (git.busy) return;
  if (!git.status?.repo) { if (!quiet) openSettings('sync'); return; }
  git.busy = true; renderGitStatus();
  try {
    await flushAll();
    const r = await api.gitSync(S.commitMessage ? applyTemplate(S.commitMessage, '') : '');
    if (r.ok) { if (!quiet || (r.log || []).some((l) => /Pulled/.test(l))) notice((r.log || ['Synced']).join('\n'), { timeout: 3500 }); }
    else notice((r.conflict ? 'Sync conflict: ' : 'Sync failed: ') + r.error + (r.files?.length ? '\n' + r.files.join('\n') : ''), { error: true, timeout: 8000 });
    await reloadFromDisk();
  } catch (e) { notice('Sync failed: ' + e.message, { error: true }); }
  git.busy = false;
  await refreshGit();
}
function setupAutoSync() {
  clearInterval(autoTimer);
  if (S.autoSync > 0) autoTimer = setInterval(() => { if (git.status?.repo && git.status.remote) syncNow({ quiet: true }); }, S.autoSync * 60000);
}

// ---------------- settings ----------------
function openSettings(section = 'general') {
  const sections = [['general', 'Appearance'], ['editor', 'Editor'], ['files', 'Files & links'], ['sync', 'GitHub sync'], ['hotkeys', 'Hotkeys'], ['about', 'About']];
  const { el } = modal('settings', `<div class="settings-nav">${sections.map(([k, l]) => `<div class="nav-item" data-s="${k}">${l}</div>`).join('')}</div><div class="settings-body"></div>`, () => { renderView(); });
  const body = el.querySelector('.settings-body');
  const show = (k) => { el.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.s === k)); renderSection(k, body); };
  el.querySelector('.settings-nav').addEventListener('click', (e) => { const n = e.target.closest('.nav-item'); if (n) show(n.dataset.s); });
  show(section);
}
function setting(name, desc, control) { return `<div class="setting"><div class="s-info"><div class="s-name">${name}</div>${desc ? `<div class="s-desc">${desc}</div>` : ''}</div>${control}</div>`; }
const toggleCtl = (key) => `<button class="toggle${S[key] ? ' on' : ''}" data-toggle="${key}"></button>`;
const textCtl = (key, ph = '') => `<input type="text" data-text="${key}" value="${esc(S[key] ?? '')}" placeholder="${esc(ph)}" spellcheck="false">`;
const numCtl = (key, min, max) => `<input type="number" data-num="${key}" value="${S[key]}" min="${min}" max="${max}">`;
const selCtl = (key, opts) => `<select data-sel="${key}">${opts.map(([v, l]) => `<option value="${v}"${String(S[key]) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
function renderSection(k, body) {
  let html = '';
  if (k === 'general') html = `<h2>Appearance</h2>`
    + setting('Theme', 'Dark or light, like Obsidian.', selCtl('theme', [['dark', 'Dark'], ['light', 'Light']]))
    + setting('Accent hue', 'Colour of links, the cursor and active elements.', `<input type="range" min="0" max="360" data-num="accentHue" value="${S.accentHue}">`)
    + setting('Font size', 'Text size of notes, in pixels.', numCtl('fontSize', 10, 30))
    + setting('Readable line length', 'Limit the width of notes so long lines are easier to read.', toggleCtl('readable'));
  if (k === 'editor') html = `<h2>Editor</h2>`
    + setting('Default view for new tabs', 'How notes open: editing (source), reading view or split (editor + live preview).', selCtl('defaultMode', [['source', 'Editing view'], ['preview', 'Reading view'], ['split', 'Split view']]))
    + setting('Spellcheck', 'Use the browser spellchecker in the editor.', toggleCtl('spellcheck'))
    + setting('Line numbers', 'Show line numbers in the editor.', toggleCtl('lineNumbers'))
    + setting('Indent using tabs', 'Turn off to indent with 4 spaces.', toggleCtl('indentWithTabs'));
  if (k === 'files') html = `<h2>Files & links</h2>`
    + setting('Default location for new notes', '', selCtl('newNoteLocation', [['root', 'Vault folder'], ['current', 'Same folder as current file'], ['folder', 'In the folder specified below']]))
    + setting('Folder for new notes', '', textCtl('newNoteFolder', 'e.g. Inbox'))
    + setting('Attachment folder', 'Pasted and dropped images/files are saved here.', textCtl('attachmentFolder', 'attachments'))
    + setting('Templates folder', 'Notes in this folder can be inserted with “Templates: Insert template”. Supports {{title}}, {{date}}, {{time}}, {{date:DD MMM YYYY}}.', textCtl('templatesFolder', 'Templates'))
    + setting('Daily notes folder', '', textCtl('dailyFolder', 'Daily'))
    + setting('Daily note date format', 'Tokens: YYYY MM DD ddd dddd MMM MMMM', textCtl('dailyFormat', 'YYYY-MM-DD'))
    + setting('Daily note template', 'Path or name of a note to use as the template.', textCtl('dailyTemplate', 'Templates/Daily'))
    + setting('Confirm file deletion', 'Deleted files go to the vault\'s .trash folder either way.', toggleCtl('confirmDelete'));
  if (k === 'hotkeys') html = `<h2>Hotkeys</h2><div class="s-desc" style="margin-bottom:10px">Browsers reserve Ctrl+N / Ctrl+W / Ctrl+T, so Notebook uses Alt for those. Install the app (browser menu → “Install Notebook”) for a desktop-like window.</div>`
    + commands.filter((c) => c.key).map((c) => setting(esc(c.name), '', `<span class="s-key" style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">${esc(c.key)}</span>`)).join('')
    + setting('Editor', 'Ctrl+B bold · Ctrl+I italic · Ctrl+K link · Ctrl+Shift+H highlight · Ctrl+/ comment · Alt+↑/↓ move line · Ctrl+D delete line · Ctrl+H replace · Ctrl+Space link suggestions · Ctrl+click follow link', '');
  if (k === 'about') html = `<h2>About</h2>` + setting('Vault location', esc(vault.root), '') + setting('Notebook', 'Local-first markdown notes. Files are plain markdown on disk; GitHub sync uses git.', '');
  if (k === 'sync') return renderSyncSection(body);
  body.innerHTML = html;
  bindSettingControls(body);
}
function bindSettingControls(body) {
  const after = (key) => {
    saveSettings(); applyAppearance();
    if (['spellcheck', 'lineNumbers', 'indentWithTabs'].includes(key)) { editor.cm.setOption('spellcheck', S.spellcheck); editor.cm.setOption('lineNumbers', S.lineNumbers); editor.cm.setOption('indentWithTabs', S.indentWithTabs); }
    if (key === 'autoSync') setupAutoSync();
  };
  body.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.toggle; S[k] = !S[k]; b.classList.toggle('on', S[k]); after(k); }));
  body.querySelectorAll('[data-text]').forEach((i) => i.addEventListener('change', () => { S[i.dataset.text] = i.value.trim(); after(i.dataset.text); }));
  body.querySelectorAll('[data-num]').forEach((i) => i.addEventListener('input', () => { const v = Number(i.value); if (!Number.isNaN(v)) { S[i.dataset.num] = v; after(i.dataset.num); } }));
  body.querySelectorAll('[data-sel]').forEach((s) => s.addEventListener('change', () => { S[s.dataset.sel] = s.value; after(s.dataset.sel); }));
}
async function renderSyncSection(body) {
  body.innerHTML = '<h2>GitHub sync</h2><div class="empty-msg">Checking git status…</div>';
  await refreshGit();
  const s = git.status || { repo: false };
  const connected = s.repo && s.remote;
  body.innerHTML = `<h2>GitHub sync</h2>
    <div class="s-desc" style="margin-bottom:12px">Your vault lives in <code>${esc(vault.root)}</code>. Syncing commits it with git and pushes to GitHub, so you get full history and can use the vault on several machines. Your existing git login is used (Git Credential Manager, SSH keys, or a token in the URL).</div>`
    + setting('Status', connected ? `Connected to <b>${esc(s.remote)}</b> on branch <b>${esc(s.branch)}</b>.<br>${s.changes.length} uncommitted change(s) · ${s.ahead || 0} to push · ${s.behind || 0} to pull${s.lastCommit ? `<br>Last commit: ${esc(s.lastCommit.message)} (${esc(new Date(s.lastCommit.date).toLocaleString())})` : ''}${s.conflicts?.length ? `<br><b style="color:#e5534b">Conflicts:</b> ${s.conflicts.map(esc).join(', ')}` : ''}`
      : s.repo ? 'The vault is a git repository but has no GitHub remote yet.' : 'Not connected.', connected ? '<button class="btn cta" id="git-sync">Sync now</button>' : '')
    + setting(connected ? 'Change repository' : 'Connect a GitHub repository', 'Create a repo on GitHub first (private is fine), then paste its URL. Empty and existing repos both work: existing notes are merged with the vault.',
      `<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><input type="text" id="git-remote" placeholder="https://github.com/you/notes.git" value="${connected ? '' : ''}" spellcheck="false"><input type="text" id="git-branch" placeholder="branch (optional, default main)" spellcheck="false"><button class="btn${connected ? '' : ' cta'}" id="git-connect">Connect</button></div>`)
    + setting('Auto sync interval', 'Minutes between automatic syncs. 0 turns it off.', numCtl('autoSync', 0, 1440))
    + setting('Sync on startup', 'Pull the latest notes from GitHub when Notebook opens.', toggleCtl('syncOnStart'))
    + setting('Commit message', 'Leave blank for “vault backup: &lt;date time&gt;”. Supports {{date}} and {{time}}.', textCtl('commitMessage', 'vault backup: {{date}} {{time}}'))
    + (s.changes?.length ? `<div class="pane-heading" style="padding-left:0"><span>Uncommitted changes</span></div><div class="git-changes">${s.changes.slice(0, 200).map((c) => `${esc(c.code)}  ${esc(c.path)}`).join('<br>')}</div>` : '')
    + '<div class="sync-log" id="git-log" style="display:none"></div>';
  bindSettingControls(body);
  const log = body.querySelector('#git-log');
  const showLog = (r) => { log.style.display = 'block'; log.textContent = [...(r.log || []), r.ok ? '✓ Done' : '✗ ' + r.error, ...(r.files || [])].join('\n'); };
  body.querySelector('#git-connect').addEventListener('click', async (e) => {
    const remote = body.querySelector('#git-remote').value.trim();
    const branch = body.querySelector('#git-branch').value.trim();
    if (!remote) return notice('Paste the repository URL first');
    e.target.disabled = true; e.target.textContent = 'Connecting…';
    await flushAll();
    const r = await api.gitSetup(remote, branch).catch((err) => ({ ok: false, error: err.message }));
    showLog(r);
    e.target.disabled = false; e.target.textContent = 'Connect';
    await reloadFromDisk();
    await refreshGit();
    if (r.ok) { notice('Vault connected to GitHub'); setTimeout(() => renderSyncSection(body), 1200); }
  });
  body.querySelector('#git-sync')?.addEventListener('click', async (e) => { e.target.disabled = true; await syncNow(); renderSyncSection(body); });
}

// ---------------- global wiring ----------------
function bindChrome() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (b && !b.closest('.modal')) { e.preventDefault(); runCommand(b.dataset.cmd); }
  });
  $$('#left .side-tab').forEach((b) => b.addEventListener('click', () => showLeftPane(b.dataset.pane)));
  $$('#right .side-tab').forEach((b) => b.addEventListener('click', () => showRightPane(b.dataset.pane)));
  $('#tag-list').addEventListener('click', (e) => { const r = e.target.closest('.tag-row'); if (r) openSearch(`tag:#${r.dataset.tag}`); });
  $('#bookmark-list').addEventListener('click', (e) => { const r = e.target.closest('[data-path]'); if (r) openFile(r.dataset.path, { newTab: e.ctrlKey || e.metaKey }); });
  $('#st-sync').addEventListener('click', () => (git.status?.repo && git.status.remote ? syncNow() : openSettings('sync')));
  $('#more-btn').addEventListener('click', (e) => {
    const t = cur(); const r = e.currentTarget.getBoundingClientRect();
    const items = t?.path ? [
      { label: t.mode === 'preview' ? 'Editing view' : 'Reading view', icon: t.mode === 'preview' ? 'pencil' : 'book-open', action: () => runCommand('toggle-mode') },
      { label: 'Split view', icon: 'columns-2', action: () => runCommand('toggle-split') },
      'sep',
      { label: 'Reveal file in navigation', icon: 'folder-search', action: () => runCommand('reveal') },
      { label: 'Open local graph', icon: 'waypoints', action: () => runCommand('local-graph') },
      { label: 'File info & git history', icon: 'history', action: () => { if (S.rightCollapsed) toggleRight(); showRightPane('properties'); } },
      'sep', ...fileMenuItems(t.path),
    ] : [{ label: 'New note', icon: 'square-pen', action: () => createNote() }];
    menu(r.right - 200, r.bottom + 4, items);
  });
  // click the breadcrumb title or edit the inline title to rename
  $('#view-title').addEventListener('click', (e) => { if (e.target.closest('.title-name')) { const p = cur()?.path; if (p) renameFlow(p); } });
  for (const id of ['#inline-title-src', '#inline-title-prev']) {
    const it = $(id);
    const commit = () => {
      const p = it.dataset.path, v = it.value.trim().replace(/[\\/:*?"<>|]/g, '-');
      if (!p) return;
      const old = isMd(p) ? stem(p) : basename(p);
      if (!v) { it.value = old; return; }
      if (v !== old) renamePath(p, (dirname(p) ? dirname(p) + '/' : '') + v + (isMd(p) ? '.md' : ''));
    };
    it.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || (e.key === 'ArrowDown' && id === '#inline-title-src')) { e.preventDefault(); it.blur(); if (cur()?.mode !== 'preview') { editor.cm.focus(); editor.cm.setCursor({ line: 0, ch: 0 }); } }
      if (e.key === 'Escape') { it.value = isMd(it.dataset.path) ? stem(it.dataset.path) : basename(it.dataset.path); it.blur(); }
    });
    it.addEventListener('blur', commit);
  }
  // sidebar resizers
  $$('.resizer').forEach((r) => r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const side = r.dataset.for, x0 = e.clientX, w0 = side === 'left' ? S.leftW : S.rightW;
    r.classList.add('dragging');
    const move = (ev) => { const w = Math.max(180, Math.min(600, w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX))); S[side === 'left' ? 'leftW' : 'rightW'] = w; applyAppearance(); };
    const up = () => { r.classList.remove('dragging'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); saveSettings(); graph?.resize(); localGraph?.resize(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }));
  // split view: keep preview roughly aligned with the editor
  sourceScroller().addEventListener('scroll', () => {
    const t = cur();
    if (t?.mode !== 'split' || !previewRoot) return;
    const sc = sourceScroller();
    const top = sc.scrollTop - editor.cm.getWrapperElement().offsetTop;
    const line = editor.cm.lineAtHeight(Math.max(0, top), 'local');
    const els = [...previewRoot.querySelectorAll('[data-line]')];
    let best = null;
    for (const el of els) { if (+el.dataset.line <= line) best = el; else break; }
    if (best) previewScroller().scrollTop = best.offsetTop - 10;
    else if (line === 0) previewScroller().scrollTop = 0;
  }, { passive: true });
  let stTimer; editor.cm.on('cursorActivity', () => { clearTimeout(stTimer); stTimer = setTimeout(updateStatus, 150); });
  // dropping files anywhere else imports them into the attachment folder
  const ov = document.createElement('div'); ov.className = 'drop-overlay'; ov.textContent = 'Drop files to add them to the vault'; document.body.appendChild(ov);
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; ov.classList.add('show'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ov.classList.remove('show'); } });
  window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    dragDepth = 0; ov.classList.remove('show');
    if (e.defaultPrevented || !e.dataTransfer.files.length) return;
    e.preventDefault();
    saveAttachments([...e.dataTransfer.files], editor.path && cur()?.mode !== 'preview' ? editor.cm : null);
  });
}

function keyString(e) {
  const k = e.key.length === 1 ? e.key.toUpperCase() : { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[e.key] || e.key;
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
}
function bindKeys() {
  const map = new Map(commands.filter((c) => c.key).map((c) => [c.key, c]));
  map.set('Ctrl+N', commands.find((c) => c.id === 'new-note'));
  map.set('Ctrl+Shift+T', commands.find((c) => c.id === 'reopen-tab'));
  document.addEventListener('keydown', (e) => {
    if ($('#modal-root').children.length || e.defaultPrevented) return; // CodeMirror already handled it
    const ks = keyString(e);
    if (ks === 'Ctrl+Enter' || ks === 'Ctrl+F' || ks === 'Ctrl+S') {
      if (ks === 'Ctrl+S') { e.preventDefault(); runCommand('save'); return; }
      if (document.activeElement?.closest('.CodeMirror')) return; // the editor handles these itself
    }
    if (/^Alt\+[1-9]$/.test(ks)) { e.preventDefault(); const t = tabs[Math.min(+ks.slice(-1), tabs.length) - 1]; if (t) activate(t.id); return; }
    const c = map.get(ks);
    if (!c) return;
    if (ks === 'F2' && document.activeElement?.matches('input, textarea')) return;
    e.preventDefault(); e.stopPropagation();
    c.run();
  });
}

function connectEvents() {
  let es;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('change', async (ev) => {
      const { paths } = JSON.parse(ev.data);
      try { await onExternalChange(paths); } catch (e) { console.warn(e); }
    });
    es.onerror = () => { es.close(); setTimeout(open, 3000); };
  };
  open();
}
let extQueue = Promise.resolve();
function onExternalChange(paths) {
  extQueue = extQueue.then(async () => {
    if (paths.includes('*')) { await reloadFromDisk(); scheduleGitRefresh(); return; }
    const { files } = await api.files();
    setFiles(files);
    let rerender = false;
    for (const p of paths) {
      const exists = fileExists(p);
      if (isMd(p)) {
        if (!exists) { dropNote(p); continue; }
        if (dirty.has(p)) continue;
        const c = await api.read(p).catch(() => null);
        if (c == null || c === vault.notes.get(p)) continue;
        setNote(p, c); editor.replace(p, c);
        rerender = true;
      } else if (textCache.has(p) && !dirty.has(p)) { textCache.delete(p); if (cur()?.path === p) rerender = true; }
    }
    for (const t of [...tabs]) if (t.path && !fileExists(t.path) && !dirty.has(t.path)) closeTab(t.id);
    renderTree();
    if (rerender) { const t = cur(); if (t?.path && paths.includes(t.path)) { rememberScroll(t); await renderView(); } else updateRight(); }
    scheduleGitRefresh();
  });
  return extQueue;
}

// ---------------- boot ----------------
async function main() {
  applyAppearance();
  icons();
  editor.mount($('#editor-host'), S);
  bindTabs(); bindTree(); bindSearch(); bindRight(); bindPreview(); bindGraphControls(); bindChrome(); bindKeys();
  try { await loadVault(); }
  catch (e) { notice('Could not load the vault: ' + e.message, { error: true, timeout: 0 }); return; }
  renderTree(); renderTags(); renderBookmarks();
  showLeftPane(S.leftPane); showRightPane(S.rightPane);
  // restore tabs
  let ws = null; try { ws = JSON.parse(localStorage.getItem('mdvault.workspace') || 'null'); } catch {}
  if (ws?.tabs?.length) {
    tabs = ws.tabs.map((t) => ({ ...t, id: 't' + ++tabSeq, _old: t.id, hist: t.hist || (t.path ? [t.path] : []), hpos: t.hpos ?? 0 }));
    activeId = (tabs.find((t) => t._old === ws.activeId) || tabs[0]).id;
    for (const t of tabs) if (t.path && !fileExists(t.path)) { t.path = null; t.type = 'empty'; }
  } else {
    const welcome = vault.files.find((f) => /(^|\/)welcome\.md$/i.test(f.path));
    tabs = [{ id: 't' + ++tabSeq, type: welcome ? 'note' : 'empty', path: welcome?.path || null, mode: 'preview', hist: welcome ? [welcome.path] : [], hpos: 0 }];
    activeId = tabs[0].id;
    if (welcome) addFolders(dirname(welcome.path)), renderTree();
  }
  renderTabs();
  await renderView();
  connectEvents();
  await refreshGit();
  setupAutoSync();
  setInterval(refreshGit, 60000);
  if (S.syncOnStart && git.status?.repo && git.status.remote) syncNow({ quiet: true });
}
main();
