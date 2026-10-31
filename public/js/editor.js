// CodeMirror 5 editor with Obsidian-flavoured highlighting, [[link]] autocomplete and markdown shortcuts.
import { vault, fuzzy, linkTextFor, stem, isMd, resolve, esc, highlightIdx } from './vault.js';

const CM = window.CodeMirror;
const Pos = CM.Pos;

// highlight wikilinks, #tags, ==marks==, $math$, callout headers, %%comments%% and html-embed fences on top of GFM
const overlay = {
  token(stream) {
    const prev = stream.pos > 0 ? stream.string.charAt(stream.pos - 1) : ' ';
    if (stream.match(/^!?\[\[[^\]\n]+\]\]/)) return 'wikilink';
    if (stream.match(/^==[^=\s](?:[^=\n]*[^=\s])?==/)) return 'mark';
    if (/[\s(,;]/.test(prev) && stream.match(/^#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*/u)) return 'hashtag';
    if (stream.match(/^\$\$[^$]+\$\$/) || (!/\d/.test(prev) && stream.match(/^\$[^\s$](?:[^$\n]*[^\s$])?\$(?!\d)/))) return 'math';
    if (stream.sol() && stream.match(/^>\s*\[![\w-]+\][+-]?/)) return 'callout';
    if (stream.sol() && stream.match(/^\s*(```|~~~)\s*(html-embed|htmlembed|embed-html|mermaid)\b.*/)) return 'embed-fence';
    if (stream.match(/^%%.*?%%/)) return 'comment-ob';
    stream.next();
    while (!stream.eol() && !/[[!=#$>%`\s]/.test(stream.peek())) stream.next();
    return null;
  },
};
CM.defineMode('mdvault', (config) => {
  const base = CM.getMode(config, {
    name: 'yaml-frontmatter',
    base: { name: 'gfm', highlightFormatting: true, gitHubSpice: false, emoji: false, taskLists: true, strikethrough: true, xml: true },
  });
  return CM.overlayMode(base, overlay, true);
});

// ---------- formatting helpers ----------
function wrap(cm, before, after = before) {
  const sels = cm.listSelections();
  cm.operation(() => {
    for (const s of sels.reverse()) {
      const from = CM.cmpPos(s.anchor, s.head) < 0 ? s.anchor : s.head;
      const to = from === s.anchor ? s.head : s.anchor;
      const text = cm.getRange(from, to);
      if (text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length) {
        cm.replaceRange(text.slice(before.length, text.length - after.length), from, to);
      } else {
        cm.replaceRange(before + text + after, from, to);
        if (!text) cm.setCursor(Pos(from.line, from.ch + before.length));
        else cm.setSelection(Pos(from.line, from.ch + before.length), Pos(to.line, to.ch + (from.line === to.line ? before.length : 0)));
      }
    }
  });
}
export function toggleTask(cm, line) {
  const text = cm.getLine(line);
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX/\-])\]/.exec(text);
  if (m) cm.replaceRange(m[2] === ' ' ? 'x' : ' ', Pos(line, m[1].length + 1), Pos(line, m[1].length + 2));
  else {
    const l = /^(\s*)((?:[-*+]|\d+[.)])\s+)?/.exec(text);
    cm.replaceRange(`${l[1]}${l[2] || '- '}[ ] `, Pos(line, 0), Pos(line, l[0].length));
  }
}
function moveLines(cm, dir) {
  cm.operation(() => {
    const r = cm.listSelections()[0];
    let a = Math.min(r.anchor.line, r.head.line), b = Math.max(r.anchor.line, r.head.line);
    if ((dir < 0 && a === 0) || (dir > 0 && b === cm.lastLine())) return;
    const block = cm.getRange(Pos(a, 0), Pos(b, cm.getLine(b).length));
    const other = dir < 0 ? a - 1 : b + 1;
    const otherText = cm.getLine(other);
    if (dir < 0) cm.replaceRange(block + '\n' + otherText, Pos(other, 0), Pos(b, cm.getLine(b).length));
    else cm.replaceRange(otherText + '\n' + block, Pos(a, 0), Pos(other, otherText.length));
    cm.setSelection(Pos(r.anchor.line + dir, r.anchor.ch), Pos(r.head.line + dir, r.head.ch));
  });
}
function inList(cm) {
  return /^\s*([-*+]|\d+[.)])\s/.test(cm.getLine(cm.getCursor().line));
}

// ---------- [[ autocomplete ----------
function wikiHint(cm) {
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line);
  const before = line.slice(0, cur.ch);
  const m = /(!?)\[\[([^\]\n|]*)$/.exec(before);
  if (!m) return null;
  const q = m[2];
  const closes = line.slice(cur.ch).startsWith(']]');
  const from = Pos(cur.line, cur.ch - q.length);
  const to = closes ? Pos(cur.line, cur.ch + 2) : cur;
  const hash = q.indexOf('#');
  let list;
  if (hash >= 0) {
    const filePart = q.slice(0, hash), hq = q.slice(hash + 1);
    const target = filePart ? resolve(filePart, editor.path) : editor.path;
    const heads = vault.meta.get(target)?.headings || [];
    list = heads.map((h) => ({ h, f: fuzzy(hq, h.text) })).filter((x) => x.f).sort((a, b) => b.f.score - a.f.score).slice(0, 40)
      .map(({ h, f }) => ({ text: `${filePart}#${h.text}]]`, render: (el) => { el.innerHTML = `${'#'.repeat(h.level)} ${highlightIdx(h.text, f.idx)}`; } }));
  } else {
    const items = [];
    for (const f of vault.files) {
      const name = isMd(f.path) ? stem(f.path) : f.path.split('/').pop();
      const r = fuzzy(q, name) || fuzzy(q, f.path);
      if (r) items.push({ path: f.path, name, r, score: r.score + (isMd(f.path) ? 5 : 0) });
      for (const a of vault.meta.get(f.path)?.aliases || []) { const ra = fuzzy(q, a); if (ra) items.push({ path: f.path, name: a, alias: true, r: ra, score: ra.score - 1 }); }
    }
    items.sort((a, b) => b.score - a.score);
    list = items.slice(0, 50).map((it) => ({
      text: (it.alias ? `${linkTextFor(it.path)}|${it.name}` : linkTextFor(it.path)) + ']]',
      render: (el) => { el.innerHTML = `${highlightIdx(it.name, it.r.idx.filter((i) => i < it.name.length))}<span class="hint-path">${esc(it.path)}</span>`; },
    }));
    if (q.trim() && !items.some((it) => it.name.toLowerCase() === q.trim().toLowerCase()))
      list.push({ text: q.trim() + ']]', render: (el) => { el.innerHTML = `${esc(q.trim())}<span class="hint-path">new note</span>`; } });
  }
  return { list, from, to };
}

// ---------- the editor singleton ----------
export const editor = {
  cm: null,
  path: null,
  docs: new Map(),      // path -> CodeMirror.Doc (keeps undo history per note)
  onChange: null,       // (path, value) => void
  onFiles: null,        // (files: File[], cm) => Promise<void>  (pasted/dropped attachments)
  onLinkClick: null,    // (linkText, newTab) => void

  mount(host, settings) {
    this.cm = CM(host, {
      value: '', mode: 'mdvault', lineWrapping: true, viewportMargin: Infinity,
      inputStyle: 'contenteditable', spellcheck: !!settings.spellcheck, autoCloseBrackets: '()[]{}``""',
      styleActiveLine: true, indentUnit: 4, tabSize: 4, indentWithTabs: settings.indentWithTabs !== false,
      lineNumbers: !!settings.lineNumbers, extraKeys: this.keys(), configureMouse: () => ({ addNew: false }),
    });
    const cm = this.cm;
    cm.on('changes', () => { if (this.path && this.onChange) this.onChange(this.path, cm.getValue()); });
    cm.on('inputRead', (cm, ch) => {
      if (cm.state.completionActive) return;
      const cur = cm.getCursor();
      const before = cm.getLine(cur.line).slice(0, cur.ch);
      if (/\[\[[^\]\n|]*$/.test(before) && (ch.text[0] === '[' || /\w|#|\//.test(ch.text[0]))) cm.showHint({ hint: wikiHint, completeSingle: false, closeCharacters: /[\]\n]/ });
    });
    cm.on('paste', (cm, e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length && this.onFiles) { e.preventDefault(); this.onFiles(files, cm); }
    });
    cm.on('drop', (cm, e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length && this.onFiles) {
        e.preventDefault();
        const pos = cm.coordsChar({ left: e.clientX, top: e.clientY });
        cm.setCursor(pos);
        this.onFiles(files, cm);
      } else {
        const path = e.dataTransfer.getData('text/x-mdvault-path');
        if (path) {
          e.preventDefault();
          cm.setCursor(cm.coordsChar({ left: e.clientX, top: e.clientY }));
          cm.replaceSelection(`${isMd(path) ? '' : '!'}[[${linkTextFor(path)}]]`);
        }
      }
    });
    // Ctrl/Cmd-click a [[link]] in the editor to follow it
    cm.getWrapperElement().addEventListener('mousedown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
      const pos = cm.coordsChar({ left: e.clientX, top: e.clientY });
      const line = cm.getLine(pos.line);
      const re = /\[\[([^\]\n]+)\]\]/g;
      let m;
      while ((m = re.exec(line))) {
        if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) { e.preventDefault(); this.onLinkClick?.(m[1], e.shiftKey); return; }
      }
      const url = /https?:\/\/[^\s)>\]]+/g;
      while ((m = url.exec(line))) if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) { e.preventDefault(); window.open(m[0], '_blank', 'noopener'); return; }
    });
    return cm;
  },

  keys() {
    return {
      Enter: 'newlineAndIndentContinueMarkdownList',
      Tab: (cm) => (cm.somethingSelected() || inList(cm) ? cm.execCommand('indentMore') : cm.execCommand('insertTab')),
      'Shift-Tab': (cm) => cm.execCommand('indentLess'),
      'Ctrl-B': (cm) => wrap(cm, '**'), 'Cmd-B': (cm) => wrap(cm, '**'),
      'Ctrl-I': (cm) => wrap(cm, '*'), 'Cmd-I': (cm) => wrap(cm, '*'),
      'Ctrl-Shift-H': (cm) => wrap(cm, '=='), 'Ctrl-Shift-X': (cm) => wrap(cm, '~~'),
      // leave these to the app (graph, search, history navigation, sync) instead of CodeMirror's defaults
      'Ctrl-G': false, 'Shift-Ctrl-G': false, 'Shift-Ctrl-F': false, 'Alt-Left': false, 'Alt-Right': false, 'Ctrl-S': false, 'Shift-Ctrl-S': false,
      'Ctrl-`': (cm) => wrap(cm, '`'),
      'Ctrl-/': (cm) => wrap(cm, '%%'),
      'Ctrl-K': (cm) => { const t = cm.getSelection(); cm.replaceSelection(`[${t}]()`); const c = cm.getCursor(); cm.setCursor(Pos(c.line, c.ch - 1)); },
      'Ctrl-Enter': (cm) => toggleTask(cm, cm.getCursor().line), 'Cmd-Enter': (cm) => toggleTask(cm, cm.getCursor().line),
      'Alt-Up': (cm) => moveLines(cm, -1), 'Alt-Down': (cm) => moveLines(cm, 1),
      'Ctrl-F': 'findPersistent', 'Cmd-F': 'findPersistent', 'Ctrl-H': 'replace', 'Shift-Ctrl-R': 'replaceAll',
      'Ctrl-Space': (cm) => cm.showHint({ hint: wikiHint, completeSingle: false }),
      'Ctrl-D': (cm) => { const l = cm.getCursor().line; cm.replaceRange('', Pos(l, 0), l < cm.lastLine() ? Pos(l + 1, 0) : Pos(l)); },
    };
  },

  open(path, content, mode = 'mdvault') {
    let doc = this.docs.get(path);
    if (!doc) { doc = CM.Doc(content, mode); this.docs.set(path, doc); }
    else if (doc.getValue() !== content) { const c = doc.getCursor(); doc.setValue(content); doc.setCursor(c); }
    this.path = null; // suppress change events from swap
    this.cm.swapDoc(doc);
    this.path = path;
    setTimeout(() => this.cm.refresh(), 0);
  },
  /** Replace content of an open/cached doc from outside (external change), keeping cursor. */
  replace(path, content) {
    const doc = this.docs.get(path);
    if (!doc || doc.getValue() === content) return;
    const cur = doc.getCursor(), active = this.path === path;
    if (active) this.path = null;
    doc.setValue(content);
    doc.setCursor(cur);
    if (active) this.path = path;
  },
  rename(from, to) { const d = this.docs.get(from); if (d) { this.docs.delete(from); this.docs.set(to, d); } if (this.path === from) this.path = to; },
  forget(path) { this.docs.delete(path); if (this.path === path) this.path = null; },
  insert(text) { this.cm.replaceSelection(text); this.cm.focus(); },
  goToLine(line, ch = 0) {
    const cm = this.cm;
    line = Math.max(0, Math.min(line, cm.lastLine()));
    cm.setCursor(Pos(line, ch));
    cm.focus();
    const top = cm.charCoords(Pos(line, 0), 'local').top;
    const sc = cm.getWrapperElement().closest('.scroller');
    if (sc) sc.scrollTop = Math.max(0, cm.getWrapperElement().offsetTop + top - sc.clientHeight / 3);
  },
};
