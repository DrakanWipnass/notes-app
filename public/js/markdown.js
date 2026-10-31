// Markdown -> DOM with Obsidian extensions:
//   [[wikilinks]], ![[embeds]] (notes, sections, images, audio/video, pdf, .html files), #tags, ==highlights==,
//   callouts, $math$, ```mermaid, task lists, footnotes, frontmatter properties, %%comments%%,
//   and rendered HTML/CSS: ```html-embed blocks (shadow DOM, or a sandboxed iframe when they contain scripts),
//   ![[diagram.html]] file embeds and raw inline HTML — each isolated so its CSS can't leak into the app.
import { vault, resolve, parseLinkText, splitFrontmatter, extractSection, ext, stem, basename, dirname, isMd, IMAGE_EXT, AUDIO_EXT, VIDEO_EXT, esc } from './vault.js';
import { rawUrl, api } from './api.js';

const HTML_EMBED_LANGS = new Set(['html-embed', 'htmlembed', 'embed-html', 'html-render', 'render-html']);

// ---------------- markdown-it setup ----------------
const md = window.markdownit({
  html: true, linkify: true, breaks: true, typographer: false,
  highlight(code, lang) {
    if (lang && window.hljs?.getLanguage(lang)) { try { return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {} }
    return esc(code);
  },
});
md.use(window.markdownitFootnote);
md.linkify.set({ fuzzyLink: false });

// [[wikilink]] and ![[embed]]
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const s = state.src, pos = state.pos;
  let start = pos, embed = false;
  if (s.charCodeAt(pos) === 0x21) { if (s.charCodeAt(pos + 1) !== 0x5b || s.charCodeAt(pos + 2) !== 0x5b) return false; embed = true; start++; }
  else if (s.charCodeAt(pos) !== 0x5b || s.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = s.indexOf(']]', start + 2);
  if (end < 0) return false;
  const inner = s.slice(start + 2, end);
  if (!inner.trim() || /[\n[\]]/.test(inner)) return false;
  if (!silent) { const t = state.push(embed ? 'wiki_embed' : 'wikilink', '', 0); t.meta = parseLinkText(inner); t.content = inner; }
  state.pos = end + 2;
  return true;
});
md.renderer.rules.wikilink = (tokens, i, _o, env) => {
  const { file, sub, alias } = tokens[i].meta;
  const target = file ? resolve(file, env.path) : env.path;
  const text = alias || (file ? (sub ? `${file} > ${sub.replace(/#/g, ' > ')}` : file) : sub);
  const href = (target || file) + (sub ? '#' + sub : '');
  return `<a class="internal-link${target ? '' : ' is-unresolved'}" data-href="${esc(href)}" data-path="${esc(target || '')}" data-sub="${esc(sub)}" href="#">${esc(text)}</a>`;
};
md.renderer.rules.wiki_embed = (tokens, i) => `<span class="embed-slot" data-src="${esc(tokens[i].content)}"></span>`;

// ==highlight==
md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
  const s = state.src, pos = state.pos;
  if (s.charCodeAt(pos) !== 0x3d || s.charCodeAt(pos + 1) !== 0x3d || s.charCodeAt(pos + 2) === 0x20 || s.charCodeAt(pos + 2) === 0x3d) return false;
  const end = s.indexOf('==', pos + 2);
  if (end < 0 || s.slice(pos + 2, end).includes('\n\n') || s.charCodeAt(end - 1) === 0x20) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const max = state.posMax;
    state.pos = pos + 2; state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
});

// #tags
md.inline.ruler.after('wikilink', 'hashtag', (state, silent) => {
  const s = state.src, pos = state.pos;
  if (s.charCodeAt(pos) !== 0x23) return false;
  if (pos > 0 && !/[\s(,;]/.test(s[pos - 1])) return false;
  const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(s.slice(pos));
  if (!m) return false;
  if (!silent) { const t = state.push('hashtag', '', 0); t.content = m[1]; }
  state.pos += m[0].length;
  return true;
});
md.renderer.rules.hashtag = (tokens, i) => `<a class="tag" data-tag="${esc(tokens[i].content)}" href="#">#${esc(tokens[i].content)}</a>`;

// $inline$ and $$display$$ math
function katex(src, display) {
  try { return window.katex.renderToString(src, { displayMode: display, throwOnError: false, output: 'html' }); }
  catch (e) { return `<span class="math-error">${esc(e.message)}</span>`; }
}
md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  const s = state.src, pos = state.pos;
  if (s.charCodeAt(pos) !== 0x24) return false;
  if (s.charCodeAt(pos + 1) === 0x24) {
    const end = s.indexOf('$$', pos + 2);
    if (end < 0) return false;
    if (!silent) { const t = state.push('math_display', '', 0); t.content = s.slice(pos + 2, end); }
    state.pos = end + 2; return true;
  }
  if (/\s/.test(s[pos + 1] || ' ')) return false;
  let end = pos + 1;
  while ((end = s.indexOf('$', end)) >= 0) {
    if (s[end - 1] === '\\') { end++; continue; }
    if (/\s/.test(s[end - 1]) || /\d/.test(s[end + 1] || '')) { end++; continue; }
    break;
  }
  if (end < 0 || end === pos + 1 || s.slice(pos + 1, end).includes('\n\n')) return false;
  if (!silent) { const t = state.push('math_inline', '', 0); t.content = s.slice(pos + 1, end); }
  state.pos = end + 1;
  return true;
});
md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.src.slice(pos, pos + 2) !== '$$') return false;
  pos += 2;
  let first = state.src.slice(pos, max), content = '', next = startLine;
  if (first.trim().endsWith('$$')) content = first.trim().slice(0, -2);
  else {
    const lines = [first];
    for (next = startLine + 1; next < endLine; next++) {
      const l = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
      if (l.trim().endsWith('$$')) { lines.push(l.trim().slice(0, -2)); break; }
      lines.push(l);
    }
    if (next >= endLine) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const t = state.push('math_display', '', 0);
  t.content = content; t.map = [startLine, next + 1]; t.block = true;
  state.line = next + 1;
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.math_inline = (t, i) => katex(t[i].content, false);
md.renderer.rules.math_display = (t, i) => `<div class="math-block">${katex(t[i].content, true)}</div>`;

// fenced code: mermaid, html-embed, highlighted code with copy button
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, i, opts, env, self) => {
  const t = tokens[i];
  const info = t.info.trim();
  const lang = info.split(/\s+/)[0].toLowerCase();
  const enc = encodeURIComponent(t.content);
  const line = t.map ? t.map[0] + (env.lineOffset || 0) : '';
  if (lang === 'mermaid') return `<div class="mermaid-block" data-src="${enc}"></div>`;
  if (HTML_EMBED_LANGS.has(lang) || (lang === 'html' && /\b(render|embed|preview)\b/.test(info))) {
    const h = /\bheight=(\d+)/.exec(info);
    return `<div class="html-embed" data-src="${enc}" data-line="${line}"${h ? ` data-height="${h[1]}"` : ''}></div>`;
  }
  const html = defaultFence(tokens, i, opts, env, self);
  return html.replace(/<\/pre>\s*$/, `<button class="copy-code" data-src="${enc}">Copy</button>${lang ? `<span class="code-lang">${esc(lang)}</span>` : ''}</pre>`);
};

// task lists + heading ids + source line numbers
md.core.ruler.push('obsidian_extras', (state) => {
  const toks = state.tokens, off = state.env.lineOffset || 0;
  const slugs = new Map();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'heading_open' && toks[i + 1]) {
      const text = toks[i + 1].children?.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('') || toks[i + 1].content;
      let slug = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'h';
      const n = slugs.get(slug) || 0; slugs.set(slug, n + 1);
      if (n) slug += '-' + n;
      t.attrSet('id', slug);
      t.attrSet('data-heading', text);
    }
    if (t.map && t.block && t.nesting === 1) t.attrSet('data-line', String(t.map[0] + off));
    if (t.type === 'inline' && toks[i - 1]?.type === 'paragraph_open' && toks[i - 2]?.type === 'list_item_open') {
      const m = /^\[([ xX/\-])\](?:[ \t]|$)/.exec(t.content);
      if (!m || !t.children?.length || t.children[0].type !== 'text') continue;
      const checked = m[1] !== ' ';
      t.children[0].content = t.children[0].content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="task-list-item-checkbox" data-line="${toks[i - 2].map[0] + off}"${checked ? ' checked' : ''}> `;
      t.children.unshift(box);
      toks[i - 2].attrJoin('class', 'task-list-item' + (checked ? ' is-checked' : ''));
      toks[i - 2].attrSet('data-task', m[1]);
      for (let j = i - 3; j >= 0; j--) if (toks[j].type === 'bullet_list_open' || toks[j].type === 'ordered_list_open') { if (toks[j].level === toks[i - 2].level - 1) { toks[j].attrJoin('class', 'contains-task-list'); break; } }
    }
  }
});

// external links open in a new tab
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  const href = tokens[i].attrGet('href') || '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { tokens[i].attrJoin('class', 'external-link'); tokens[i].attrSet('target', '_blank'); tokens[i].attrSet('rel', 'noopener noreferrer'); }
  return self.renderToken(tokens, i, opts);
};

// ---------------- callouts ----------------
const CALLOUT_ICONS = {
  note: 'pencil', abstract: 'clipboard-list', summary: 'clipboard-list', tldr: 'clipboard-list', info: 'info', todo: 'circle-check',
  tip: 'flame', hint: 'flame', important: 'flame', success: 'check', check: 'check', done: 'check', question: 'circle-help', help: 'circle-help',
  faq: 'circle-help', warning: 'triangle-alert', caution: 'triangle-alert', attention: 'triangle-alert', failure: 'x', fail: 'x', missing: 'x',
  danger: 'zap', error: 'zap', bug: 'bug', example: 'list', quote: 'quote', cite: 'quote',
};
export function icon(name, size = 18) {
  const node = window.lucide?.icons?.[name.replace(/(^|-)(\w)/g, (_, _d, c) => c.toUpperCase())];
  if (!node) return '';
  const svg = window.lucide.createElement(node);
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  return svg.outerHTML;
}
function calloutize(root) {
  for (const bq of root.querySelectorAll('blockquote')) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') continue;
    const m = /^\s*\[!([\w-]+)\]([+-]?)[ \t]*([^\n<]*)(?:<br>)?\n?/.exec(p.innerHTML);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const div = document.createElement('div');
    div.className = 'callout' + (m[2] ? ' is-collapsible' : '') + (m[2] === '-' ? ' is-collapsed' : '');
    div.dataset.callout = type;
    if (bq.dataset.line) div.dataset.line = bq.dataset.line;
    const title = m[3].trim() || type[0].toUpperCase() + type.slice(1);
    div.innerHTML = `<div class="callout-title"><span class="callout-icon">${icon(CALLOUT_ICONS[type] || 'pencil')}</span><span class="callout-title-inner">${title}</span>${m[2] ? `<span class="callout-fold">${icon('chevron-down', 16)}</span>` : ''}</div><div class="callout-content"></div>`;
    p.innerHTML = p.innerHTML.slice(m[0].length);
    const content = div.lastChild;
    if (!p.innerHTML.trim()) p.remove();
    while (bq.firstChild) content.appendChild(bq.firstChild);
    bq.replaceWith(div);
  }
}

// ---------------- sanitising raw HTML ----------------
// Notes are your own, but a pulled repo or pasted HTML shouldn't be able to run code at the app's origin.
function sanitize(root) {
  root.querySelectorAll('script, object, embed:not([data-ok]), base, meta, link:not([rel=stylesheet])').forEach((n) => n.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if (['href', 'src', 'xlink:href', 'action', 'formaction', 'srcdoc'].includes(n)) {
        if (n === 'srcdoc' || /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) el.removeAttribute(a.name);
      }
    }
    if (el.tagName === 'IFRAME' && !el.hasAttribute('sandbox')) el.setAttribute('sandbox', 'allow-scripts allow-popups');
  }
}
/** Point relative src/href in raw HTML at vault files. */
function fixUrls(root, from) {
  for (const el of root.querySelectorAll('img[src], video[src], audio[src], source[src], a[href]:not(.internal-link):not(.tag)')) {
    const attr = el.hasAttribute('src') ? 'src' : 'href';
    const v = el.getAttribute(attr);
    if (!v || /^([a-z][a-z0-9+.-]*:|#|\/\/|\/vault\/|\/vendor\/)/i.test(v)) continue;
    const clean = v.split('#')[0].split('?')[0];
    const target = resolve(clean.startsWith('/') ? clean.slice(1) : clean, from);
    if (!target) continue;
    if (attr === 'href' && isMd(target)) {
      el.classList.add('internal-link'); el.dataset.path = target; el.dataset.href = target + (v.includes('#') ? '#' + v.split('#')[1] : '');
      el.setAttribute('href', '#');
    } else el.setAttribute(attr, rawUrl(target));
  }
}

// ---------------- isolated HTML rendering ----------------
let embedSeq = 0;
const iframes = new Map();
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.__mdvault) return;
  const f = iframes.get(d.id);
  if (f && e.source === f.contentWindow && !f.dataset.fixedHeight) f.style.height = Math.min(Math.max(d.h, 30), 6000) + 'px';
});

/** Wrap an HTML snippet/document for a sandboxed iframe: inherit theme colours, report height, resolve relative URLs. */
function iframeDoc(html, id, baseDir) {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const base = location.origin + '/vault/' + (baseDir ? baseDir.split('/').map(encodeURIComponent).join('/') + '/' : '');
  const head = `<base href="${esc(base)}"><meta charset="utf-8"><style>
    html{color:${v('--text-normal')};color-scheme:${document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'};font-family:${v('--font-text')};font-size:15px;line-height:1.5}
    html,body{background:transparent}body{margin:0}img{max-width:100%}</style>`;
  const tail = `<script>(function(){var id=${JSON.stringify(id)};function post(){var b=document.body,h=Math.max(b?b.scrollHeight:0,document.documentElement.scrollHeight);parent.postMessage({__mdvault:1,id:id,h:h},'*')}
    if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);window.addEventListener('load',post);setTimeout(post,50);setTimeout(post,600);
    document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(a&&!a.target)a.target='_blank'});})();<\/script>`;
  if (/<html[\s>]/i.test(html) || /<!doctype/i.test(html)) {
    let doc = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${head}`) : html.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
    doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, tail + '</body>') : doc + tail;
    return doc;
  }
  return `<!doctype html><html><head>${head}</head><body>${html}${tail}</body></html>`;
}
export function makeIframe(html, baseDir, height) {
  const id = 'e' + ++embedSeq;
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals');
  f.setAttribute('loading', 'lazy');
  f.srcdoc = iframeDoc(html, id, baseDir);
  if (height) { f.style.height = height + 'px'; f.dataset.fixedHeight = '1'; } else f.style.height = '60px';
  iframes.set(id, f);
  // forget detached iframes eventually
  if (iframes.size > 400) for (const [k, el] of iframes) if (!el.isConnected) iframes.delete(k);
  return f;
}
/** Shadow-DOM rendering for script-free HTML/CSS: `:root`, `html`, `body` selectors are re-pointed at the embed. */
function makeShadow(html, from) {
  const host = document.createElement('div');
  host.className = 'html-embed-body';
  const root = host.attachShadow({ mode: 'open' });
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  sanitize(doc.body);
  fixUrls(doc.body, from);
  for (const st of doc.querySelectorAll('style')) st.textContent = st.textContent.replace(/(^|[\s,}>~+])(:root|html|body)(?=[\s,{.:#[>~+])/g, '$1:host');
  root.innerHTML = `<style>:host{display:block}img{max-width:100%}</style>`;
  for (const n of [...doc.head.childNodes, ...doc.body.childNodes]) root.appendChild(document.importNode(n, true));
  return host;
}
const hasScript = (html) => /<script[\s>]|\son\w+\s*=/i.test(html);

function embedTools(wrapper, { html, title, baseDir, path }) {
  const tools = document.createElement('div');
  tools.className = 'embed-tools';
  tools.innerHTML = `${path ? '<button data-act="open">Open file</button>' : ''}<button data-act="source">Source</button><button data-act="full" title="Full screen">⤢</button>`;
  tools.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    e.stopPropagation();
    if (act === 'source') wrapper.classList.toggle('show-source');
    if (act === 'full') hooks.fullscreen?.({ html, title, baseDir });
    if (act === 'open') hooks.openRaw?.(path);
  });
  const src = document.createElement('pre');
  src.className = 'embed-source';
  src.innerHTML = `<code>${window.hljs ? window.hljs.highlight(html, { language: 'html' }).value : esc(html)}</code>`;
  wrapper.append(tools, src);
}
export function renderHtmlEmbed(el, html, from, height) {
  el.innerHTML = '';
  const body = hasScript(html) ? Object.assign(document.createElement('div'), { className: 'html-embed-body' }) : makeShadow(html, from);
  if (hasScript(html)) body.appendChild(makeIframe(html, dirname(from), height));
  el.appendChild(body);
  embedTools(el, { html, title: 'HTML embed', baseDir: dirname(from) });
}
export const fullscreenDoc = (html, baseDir) => { const f = makeIframe(html, baseDir); f.dataset.fixedHeight = '1'; f.style.height = '100%'; return f; };

// ---------------- embeds ![[...]] ----------------
async function renderEmbed(slot, from, depth, seen) {
  const raw = slot.dataset.src;
  const { file, sub, alias } = parseLinkText(raw);
  const target = file ? resolve(file, from) : from;
  const e = target ? ext(target) : ext(file);
  const size = /^(\d+)(?:x(\d+))?$/.exec(alias || '');
  const wrap = document.createElement('div');
  wrap.className = 'internal-embed';
  wrap.dataset.src = raw;
  if (!target) {
    wrap.innerHTML = `<div class="embed-missing">“${esc(file)}” could not be found. <a class="internal-link is-unresolved" data-href="${esc(file)}" href="#">Create it</a></div>`;
    return slot.replaceWith(wrap);
  }
  const url = rawUrl(target);
  if (IMAGE_EXT.has(e)) {
    wrap.classList.add('image-embed');
    const img = document.createElement('img');
    img.src = url; img.alt = alias && !size ? alias : basename(target); img.loading = 'lazy';
    if (size) { img.width = +size[1]; if (size[2]) img.height = +size[2]; }
    wrap.appendChild(img);
  } else if (AUDIO_EXT.has(e)) wrap.innerHTML = `<audio controls src="${url}"></audio>`;
  else if (VIDEO_EXT.has(e)) wrap.innerHTML = `<video controls src="${url}" style="max-width:100%"></video>`;
  else if (e === 'pdf') wrap.innerHTML = `<iframe src="${url}${sub ? '#' + esc(sub) : ''}" style="width:100%;height:${size ? size[1] : 640}px;border:0;border-radius:6px"></iframe>`;
  else if (e === 'html' || e === 'htm') {
    wrap.className = 'html-embed file-embed';
    let html = '';
    try { html = await api.read(target); } catch { html = '<p>Could not load ' + esc(target) + '</p>'; }
    const body = document.createElement('div');
    body.className = 'html-embed-body';
    body.appendChild(makeIframe(html, dirname(target), size ? +size[1] : 0));
    wrap.appendChild(body);
    embedTools(wrap, { html, title: target, baseDir: dirname(target), path: target });
  } else if (isMd(target)) {
    if (depth > 4 || seen.has(target + '#' + sub)) { wrap.innerHTML = `<div class="embed-missing">Embed loop: ${esc(raw)}</div>`; return slot.replaceWith(wrap); }
    const src = vault.notes.get(target) ?? '';
    const section = extractSection(src, sub);
    wrap.className = 'markdown-embed';
    wrap.innerHTML = `<div class="embed-title"><span>${esc(alias && !size ? alias : stem(target) + (sub ? ' › ' + sub : ''))}</span><a class="internal-link" data-href="${esc(target + (sub ? '#' + sub : ''))}" data-path="${esc(target)}" data-sub="${esc(sub)}" href="#">open ↗</a></div>`;
    const inner = document.createElement('div');
    wrap.appendChild(inner);
    if (section == null) inner.innerHTML = `<div class="embed-missing">Section “${esc(sub)}” not found in ${esc(stem(target))}</div>`;
    else await renderInto(inner, sub ? section : src, target, { depth: depth + 1, seen: new Set([...seen, target + '#' + sub]), embedded: true });
  } else {
    wrap.innerHTML = `<a class="external-link" href="${url}" target="_blank">${esc(basename(target))}</a>`;
  }
  slot.replaceWith(wrap);
}

// ---------------- mermaid ----------------
let mermaidTheme = null, mermaidSeq = 0;
async function renderMermaid(el) {
  const m = window.mermaid;
  const code = decodeURIComponent(el.dataset.src);
  if (!m) { el.innerHTML = `<pre><code>${esc(code)}</code></pre>`; return; }
  const theme = document.documentElement.dataset.theme === 'light' ? 'default' : 'dark';
  if (mermaidTheme !== theme) { m.initialize({ startOnLoad: false, theme, securityLevel: 'strict', fontFamily: 'inherit' }); mermaidTheme = theme; }
  try {
    const { svg } = await m.render('mmd' + ++mermaidSeq, code);
    el.innerHTML = svg;
  } catch (e) {
    el.innerHTML = `<pre class="math-error">Mermaid: ${esc(e.message || e)}</pre>`;
    document.getElementById('dmmd' + mermaidSeq)?.remove();
  }
}

// ---------------- main entry ----------------
export const hooks = {}; // set by app.js: fullscreen(), openRaw()

function propertiesTable(fm) {
  const rows = Object.entries(fm).map(([k, v]) => {
    const val = Array.isArray(v) ? v.map((x) => `<span class="pill">${esc(typeof x === 'object' ? JSON.stringify(x) : x)}</span>`).join('')
      : v instanceof Date ? esc(v.toISOString().slice(0, 10)) : typeof v === 'object' && v ? esc(JSON.stringify(v)) : esc(String(v));
    return `<tr><td>${esc(k)}</td><td>${val}</td></tr>`;
  }).join('');
  return `<div class="metadata"><div class="meta-title">Properties</div><table>${rows}</table></div>`;
}

/** Render markdown `src` (from note `path`) into element `el` (or a shadow root). */
export async function renderInto(el, src, path, { depth = 0, seen = new Set([path + '#']), embedded = false } = {}) {
  let fm = null, body = src, fmLines = 0;
  if (!embedded || depth === 0) ({ fm, body, fmLines } = splitFrontmatter(src));
  else ({ body } = splitFrontmatter(src));
  body = body.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, ''));
  const html = md.render(body, { path, lineOffset: fmLines });
  const doc = new DOMParser().parseFromString(`<body><div class="markdown-rendered">${fm && !embedded && Object.keys(fm).length ? propertiesTable(fm) : ''}${html}</div></body>`, 'text/html');
  const container = doc.body.firstChild;
  sanitize(container);
  fixUrls(container, path);
  calloutize(container);
  const out = document.importNode(container, true);
  el.replaceChildren(out);

  const jobs = [];
  for (const slot of out.querySelectorAll('.embed-slot')) jobs.push(renderEmbed(slot, path, depth, seen));
  for (const box of out.querySelectorAll('.html-embed[data-src]')) renderHtmlEmbed(box, decodeURIComponent(box.dataset.src), path, +box.dataset.height || 0);
  for (const mm of out.querySelectorAll('.mermaid-block')) jobs.push(renderMermaid(mm));
  await Promise.all(jobs);
  return out;
}

export const PREVIEW_STYLES = ['/vendor/katex/katex.min.css', '/css/preview.css'];
/** Create a shadow-root host for a note's reading view (raw <style> in a note stays inside it). */
export function createPreviewRoot(host) {
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  if (!root.querySelector('.content')) {
    root.innerHTML = PREVIEW_STYLES.map((h) => `<link rel="stylesheet" href="${h}">`).join('') + '<div class="content"></div>';
  }
  return root;
}
