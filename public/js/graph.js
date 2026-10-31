// Canvas force-directed graph (global + local). No dependencies.
import { vault, resolvedLinks, isMd, stem, basename, ext } from './vault.js';

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** Build {nodes, links} from the vault. opts: {tags, orphans, attachments, filter, center, depth} */
export function buildGraph(opts = {}) {
  const nodes = new Map(), links = [];
  const add = (id, kind, label) => { if (!nodes.has(id)) nodes.set(id, { id, kind, label, deg: 0 }); return nodes.get(id); };
  for (const [p] of vault.meta) add(p, 'note', stem(p));
  for (const [p, m] of vault.meta) {
    const seen = new Set();
    for (const l of resolvedLinks(p)) {
      let target = l.resolved;
      if (!target) { if (!l.file) continue; target = 'unresolved:' + l.file.toLowerCase(); add(target, 'unresolved', l.file); }
      else if (!isMd(target)) { if (!opts.attachments) continue; add(target, 'attachment', basename(target)); }
      if (target === p || seen.has(target)) continue;
      seen.add(target);
      links.push({ s: p, t: target });
    }
    if (opts.tags) for (const t of m.tags) { add('tag:' + t, 'tag', '#' + t); links.push({ s: p, t: 'tag:' + t }); }
  }
  for (const l of links) { nodes.get(l.s).deg++; nodes.get(l.t).deg++; }

  let keep = null;
  if (opts.center) {
    keep = new Set([opts.center]);
    let frontier = [opts.center];
    for (let d = 0; d < (opts.depth || 1); d++) {
      const next = [];
      for (const l of links) {
        if (frontier.includes(l.s) && !keep.has(l.t)) { keep.add(l.t); next.push(l.t); }
        if (frontier.includes(l.t) && !keep.has(l.s)) { keep.add(l.s); next.push(l.s); }
      }
      frontier = next;
    }
  }
  const f = (opts.filter || '').toLowerCase();
  const visible = [...nodes.values()].filter((n) => {
    if (keep && !keep.has(n.id)) return false;
    if (!keep && !opts.orphans && n.deg === 0) return false;
    if (f && n.kind !== 'tag' && !n.id.toLowerCase().includes(f)) return false;
    return true;
  });
  const ids = new Set(visible.map((n) => n.id));
  return { nodes: visible, links: links.filter((l) => ids.has(l.s) && ids.has(l.t)) };
}

export class ForceGraph {
  constructor(canvas, { onOpen, local = false } = {}) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.onOpen = onOpen; this.local = local;
    this.nodes = []; this.links = []; this.byId = new Map();
    this.view = { x: 0, y: 0, k: 1 };
    this.hover = null; this.drag = null; this.alpha = 1; this.active = null;
    this.running = false;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }
  setData({ nodes, links }, active) {
    const old = this.byId;
    this.active = active;
    this.nodes = nodes.map((n) => {
      const o = old.get(n.id);
      const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 120;
      return { ...n, x: o?.x ?? Math.cos(a) * r, y: o?.y ?? Math.sin(a) * r, vx: 0, vy: 0 };
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = links.map((l) => ({ s: this.byId.get(l.s), t: this.byId.get(l.t) })).filter((l) => l.s && l.t);
    this.nbr = new Map(this.nodes.map((n) => [n.id, new Set()]));
    for (const l of this.links) { this.nbr.get(l.s.id).add(l.t.id); this.nbr.get(l.t.id).add(l.s.id); }
    this.alpha = 1;
    this.fitPending = !old.size || this.nodes.length !== old.size;
    if (active && this.byId.get(active)) { const a = this.byId.get(active); a.x = 0; a.y = 0; }
    this.start();
  }
  resize() {
    const r = this.c.getBoundingClientRect(), d = devicePixelRatio || 1;
    if (!r.width) return;
    this.c.width = r.width * d; this.c.height = r.height * d;
    this.w = r.width; this.h = r.height;
    this.draw();
  }
  start() { if (!this.running) { this.running = true; requestAnimationFrame(() => this.tick()); } }
  stop() { this.running = false; }
  tick() {
    if (!this.running) return;
    if (!this.c.isConnected || !this.c.offsetParent) { this.running = false; return; }
    if (this.alpha > 0.005 || this.drag) this.step();
    if (this.fitPending && this.alpha < 0.25) { this.fitPending = false; this.fit(); }
    this.draw();
    requestAnimationFrame(() => this.tick());
  }
  step() {
    const N = this.nodes, a = this.alpha;
    const rep = this.local ? 1600 : 3200, L = this.local ? 70 : 95;
    for (let i = 0; i < N.length; i++) {
      const p = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const q = N[j];
        let dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 250000) continue;
        const f = (rep * a) / d2;
        p.vx += dx * f / Math.sqrt(d2); p.vy += dy * f / Math.sqrt(d2);
        q.vx -= dx * f / Math.sqrt(d2); q.vy -= dy * f / Math.sqrt(d2);
      }
    }
    for (const l of this.links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - L) / d) * 0.06 * a;
      l.s.vx += dx * f; l.s.vy += dy * f; l.t.vx -= dx * f; l.t.vy -= dy * f;
    }
    for (const n of N) {
      n.vx -= n.x * 0.012 * a; n.vy -= n.y * 0.012 * a;
      if (n === this.drag?.node) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += Math.max(-30, Math.min(30, n.vx)); n.y += Math.max(-30, Math.min(30, n.vy));
    }
    this.alpha *= 0.985;
  }
  /** Zoom/centre so the whole graph fits the canvas. */
  fit() {
    if (!this.nodes.length || !this.w) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const pad = this.local ? 50 : 90;
    this.view.k = Math.max(0.15, Math.min(this.local ? 1.6 : 2.2, Math.min(this.w / (x1 - x0 + pad * 2), this.h / (y1 - y0 + pad * 2))));
    this.view.x = (x0 + x1) / 2; this.view.y = (y0 + y1) / 2;
  }
  radius(n) { return (n.kind === 'tag' ? 3.5 : 3.5) + Math.min(9, Math.sqrt(n.deg) * 1.6); }
  toScreen(n) { return [(n.x - this.view.x) * this.view.k + this.w / 2, (n.y - this.view.y) * this.view.k + this.h / 2]; }
  toWorld(x, y) { return [(x - this.w / 2) / this.view.k + this.view.x, (y - this.h / 2) / this.view.k + this.view.y]; }
  pick(mx, my) {
    const [x, y] = this.toWorld(mx, my);
    let best = null, bd = Infinity;
    for (const n of this.nodes) { const d = (n.x - x) ** 2 + (n.y - y) ** 2, r = this.radius(n) + 4 / this.view.k; if (d < r * r && d < bd) { best = n; bd = d; } }
    return best;
  }
  draw() {
    const ctx = this.ctx, d = devicePixelRatio || 1;
    if (!this.w) return;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const col = { node: css('--graph-node'), un: css('--graph-node-unresolved'), tag: css('--graph-node-tag'), att: css('--graph-node-attach'), line: css('--graph-line'), accent: css('--interactive-accent'), text: css('--text-muted') };
    const focus = this.hover || (this.drag && this.drag.node);
    const near = focus ? this.nbr.get(focus.id) : null;
    const k = this.view.k;
    ctx.lineWidth = Math.max(0.6, 1 * Math.min(1.5, k));
    for (const l of this.links) {
      const hot = focus && (l.s === focus || l.t === focus);
      ctx.strokeStyle = hot ? col.accent : col.line;
      ctx.globalAlpha = focus && !hot ? 0.25 : 1;
      const [x1, y1] = this.toScreen(l.s), [x2, y2] = this.toScreen(l.t);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.font = `${Math.max(10, Math.min(14, 12 * k))}px ${css('--font-ui')}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const n of this.nodes) {
      const [x, y] = this.toScreen(n), r = this.radius(n) * Math.min(1.6, Math.max(0.6, k));
      if (x < -50 || y < -50 || x > this.w + 50 || y > this.h + 50) continue;
      const dim = focus && n !== focus && !near.has(n.id);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.fillStyle = n === focus || n.id === this.active ? col.accent : n.kind === 'tag' ? col.tag : n.kind === 'unresolved' ? col.un : n.kind === 'attachment' ? col.att : col.node;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      const showLabel = n === focus || (near && near.has(n.id)) || k > 0.9 || (this.local && k > 0.6) || n.id === this.active;
      if (showLabel) {
        ctx.globalAlpha = dim ? 0.15 : n === focus ? 1 : Math.min(1, (k - 0.5) * 2) || 0.9;
        if (n === focus || n.id === this.active) ctx.globalAlpha = 1;
        ctx.fillStyle = col.text;
        ctx.fillText(n.label.length > 40 ? n.label.slice(0, 38) + '…' : n.label, x, y + r + 3);
      }
    }
    ctx.globalAlpha = 1;
  }
  bind() {
    const c = this.c;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [mx, my] = pos(e), [wx, wy] = this.toWorld(mx, my);
      this.view.k = Math.max(0.1, Math.min(6, this.view.k * Math.exp(-e.deltaY * 0.0015)));
      const [nx, ny] = this.toWorld(mx, my);
      this.view.x += wx - nx; this.view.y += wy - ny;
      this.draw();
    }, { passive: false });
    c.addEventListener('mousedown', (e) => {
      const [mx, my] = pos(e);
      const n = this.pick(mx, my);
      this.drag = { node: n, sx: mx, sy: my, vx: this.view.x, vy: this.view.y, moved: false };
      c.classList.add('dragging');
      if (n) { this.alpha = Math.max(this.alpha, 0.3); this.start(); }
    });
    window.addEventListener('mousemove', (e) => {
      if (!c.offsetParent) return;
      const [mx, my] = pos(e);
      if (this.drag) {
        if (Math.abs(mx - this.drag.sx) + Math.abs(my - this.drag.sy) > 3) this.drag.moved = true;
        if (this.drag.node) { const [wx, wy] = this.toWorld(mx, my); this.drag.node.x = wx; this.drag.node.y = wy; this.alpha = Math.max(this.alpha, 0.2); }
        else { this.view.x = this.drag.vx - (mx - this.drag.sx) / this.view.k; this.view.y = this.drag.vy - (my - this.drag.sy) / this.view.k; this.draw(); }
        return;
      }
      if (e.target !== c) { if (this.hover) { this.hover = null; this.draw(); } return; }
      const n = this.pick(mx, my);
      if (n !== this.hover) { this.hover = n; c.style.cursor = n ? 'pointer' : ''; c.title = n ? n.id.replace(/^(tag|unresolved):/, '') : ''; this.draw(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (!this.drag) return;
      const { node, moved } = this.drag;
      this.drag = null; c.classList.remove('dragging');
      if (node && !moved && this.onOpen) this.onOpen(node, e);
    });
  }
}
