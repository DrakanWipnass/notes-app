// Modals, fuzzy suggest (quick switcher / command palette), context menus, notices.
import { esc } from './vault.js';

const root = () => document.getElementById('modal-root');
export const icons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.75 } });

export function notice(msg, { error = false, timeout = 4000 } = {}) {
  const n = document.createElement('div');
  n.className = 'notice' + (error ? ' error' : '');
  n.textContent = msg;
  n.onclick = () => n.remove();
  document.getElementById('notices').appendChild(n);
  if (timeout) setTimeout(() => n.remove(), error ? timeout * 2 : timeout);
  return n;
}

function overlay(modal, onClose) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.appendChild(modal);
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc_, true); onClose?.(); };
  const esc_ = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', esc_, true);
  root().appendChild(bg);
  return close;
}

export function prompt(title, value = '', { placeholder = '', cta = 'OK', select } = {}) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal prompt';
    m.innerHTML = `<h3>${esc(title)}</h3><input class="text-input" spellcheck="false" placeholder="${esc(placeholder)}"><div class="row-btns"><button class="btn" data-a="cancel">Cancel</button><button class="btn cta" data-a="ok">${esc(cta)}</button></div>`;
    const input = m.querySelector('input');
    input.value = value;
    let done = false;
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    const close = overlay(m, () => finish(null));
    m.querySelector('[data-a=cancel]').onclick = () => finish(null);
    m.querySelector('[data-a=ok]').onclick = () => finish(input.value.trim() || null);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); } });
    setTimeout(() => { input.focus(); if (select) input.setSelectionRange(...select); else input.select(); }, 0);
  });
}

export function confirm(title, body, { cta = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal prompt';
    m.innerHTML = `<h3>${esc(title)}</h3><div style="color:var(--text-muted)">${body}</div><div class="row-btns"><button class="btn" data-a="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'cta'}" data-a="ok">${esc(cta)}</button></div>`;
    let done = false;
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    const close = overlay(m, () => finish(false));
    m.querySelector('[data-a=cancel]').onclick = () => finish(false);
    const ok = m.querySelector('[data-a=ok]');
    ok.onclick = () => finish(true);
    setTimeout(() => ok.focus(), 0);
  });
}

/**
 * Generic suggest modal. getItems(query) -> [{html, sub, key, value}] ; onChoose(item, event, query)
 */
export function suggest({ placeholder, getItems, onChoose, footer = '', initial = '' }) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<input class="suggest-input" spellcheck="false" placeholder="${esc(placeholder)}"><div class="suggest-list"></div>${footer ? `<div class="suggest-footer">${footer}</div>` : ''}`;
  const input = m.querySelector('input'), list = m.querySelector('.suggest-list');
  let items = [], sel = 0;
  const close = overlay(m);
  const render = () => {
    items = getItems(input.value);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? items.map((it, i) => `<div class="suggest-item${i === sel ? ' is-selected' : ''}" data-i="${i}"><div style="min-width:0"><div class="s-main">${it.html}</div>${it.sub ? `<div class="s-sub">${it.sub}</div>` : ''}</div>${it.key ? `<span class="s-key">${esc(it.key)}</span>` : ''}</div>`).join('')
      : `<div class="empty-msg">No matches</div>`;
  };
  const move = (d) => {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    list.querySelectorAll('.suggest-item').forEach((el, i) => el.classList.toggle('is-selected', i === sel));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (e) => { const it = items[sel]; const q = input.value; close(); onChoose(it, e, q); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(e); }
  });
  list.addEventListener('mousemove', (e) => { const el = e.target.closest('.suggest-item'); if (el && +el.dataset.i !== sel) { sel = +el.dataset.i; list.querySelectorAll('.suggest-item').forEach((x, i) => x.classList.toggle('is-selected', i === sel)); } });
  list.addEventListener('click', (e) => { if (e.target.closest('.suggest-item')) choose(e); });
  input.value = initial;
  render();
  setTimeout(() => input.focus(), 0);
}

let openMenu = null;
/** items: [{label, icon, action, danger}] or 'sep' */
export function menu(x, y, items) {
  openMenu?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map((it, i) => it === 'sep' ? '<div class="menu-sep"></div>' : `<div class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}">${it.icon ? `<i data-lucide="${it.icon}"></i>` : ''}<span>${esc(it.label)}</span></div>`).join('');
  document.body.appendChild(m);
  icons();
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  openMenu = m;
  const close = () => { m.remove(); openMenu = null; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); };
  const outside = (e) => { if (!m.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); }, 0);
  m.addEventListener('click', (e) => {
    const el = e.target.closest('.menu-item');
    if (!el) return;
    close();
    items[+el.dataset.i].action();
  });
}

/** Generic modal shell; returns {el, close} */
export function modal(className, html, onClose) {
  const m = document.createElement('div');
  m.className = 'modal ' + className;
  m.innerHTML = html;
  const close = overlay(m, onClose);
  return { el: m, close };
}
