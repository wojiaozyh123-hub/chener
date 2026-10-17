// 编辑器页面：画布上的选择、拖动、平移缩放、双击改名、点线改基数、右键换形状；选中后右侧出现字体/字号/加粗/形状。
// 画布内容是核心库画出来的 SVG（和导出的是同一个函数），这里只负责交互，改动都变成修改操作交给主进程。

import type { EdgeMeta, NodeMeta, Payload } from './protocol.js';

interface Api {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
  on(channel: string, cb: (data: unknown) => void): void;
}
declare global {
  interface Window {
    chener: Api;
  }
}

const api = window.chener;
const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
const canvas = $<SVGSVGElement>('canvas');
const vp = $<SVGGElement>('vp');
const startScreen = $<HTMLDivElement>('start');
const panel = $<HTMLDivElement>('panel');
const editor = $<HTMLInputElement>('editor');
const pFamily = $<HTMLInputElement>('pFamily');
const pSize = $<HTMLInputElement>('pSize');
const pBold = $<HTMLInputElement>('pBold');
const pShape = $<HTMLSelectElement>('pShape');

let P: Payload | null = null;
let tf = { s: 1, x: 0, y: 0 };
let sel = new Set<string>();
let nodeById = new Map<string, NodeMeta>();
let edgeById = new Map<string, EdgeMeta>();
let nodeEl = new Map<string, SVGGElement>();

// ---------- 渲染 ----------
function render(p: Payload): void {
  const newFile = !P || P.file !== p.file;
  P = p;
  nodeById = new Map(p.nodes.map((n) => [n.id, n]));
  edgeById = new Map(p.edges.map((e) => [e.id, e]));
  sel = new Set([...sel].filter((id) => nodeById.has(id)));
  vp.innerHTML = p.svg;
  nodeEl = new Map([...vp.querySelectorAll<SVGGElement>('[data-node]')].map((g) => [g.dataset.node!, g]));
  startScreen.hidden = true;
  canvas.style.display = 'block';
  markSelection();
  if (newFile) fit();
  else applyTf();
  updatePanel();
  void api.invoke('rendered');
}

function applyTf(): void {
  vp.setAttribute('transform', `translate(${tf.x} ${tf.y}) scale(${tf.s})`);
}

function fit(): void {
  if (!P) return;
  const r = canvas.getBoundingClientRect();
  const b = P.bounds;
  const pad = 40;
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const s = Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh, 1.6);
  tf = { s, x: (r.width - bw * s) / 2 - b.minX * s, y: (r.height - bh * s) / 2 - b.minY * s };
  applyTf();
}

function zoomAt(factor: number, cx: number, cy: number): void {
  const s = Math.min(6, Math.max(0.05, tf.s * factor));
  const f = s / tf.s;
  tf = { s, x: cx - (cx - tf.x) * f, y: cy - (cy - tf.y) * f };
  applyTf();
}

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left - tf.x) / tf.s, y: (clientY - r.top - tf.y) / tf.s };
}

function toScreen(x: number, y: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: r.left + tf.x + x * tf.s, y: r.top + tf.y + y * tf.s };
}

function markSelection(): void {
  for (const [id, g] of nodeEl) g.classList.toggle('sel', sel.has(id));
}

// ---------- 选中后的属性面板 ----------
function updatePanel(): void {
  const first = [...sel].map((id) => nodeById.get(id)).find(Boolean);
  panel.hidden = !first;
  if (!first) return;
  if (document.activeElement !== pFamily) pFamily.value = first.family;
  if (document.activeElement !== pSize) pSize.value = String(first.size);
  pBold.checked = first.bold;
  pShape.value = first.shape;
}

function selectedIds(): string[] {
  return [...sel].filter((id) => nodeById.has(id));
}

function styleOps(prop: 'fontFamily' | 'fontSize' | 'bold', value: string | number | boolean): unknown[] {
  const ops: unknown[] = selectedIds().map((id) => ({ op: 'set_style', id, [prop]: value }));
  // 全选时连基数标签的字体也一起改
  if (P && sel.size === P.nodes.length) ops.push({ op: 'set_style', kind: 'card', [prop]: value });
  return ops;
}

pFamily.addEventListener('change', () => {
  if (pFamily.value.trim()) void api.invoke('apply', { ops: styleOps('fontFamily', pFamily.value.trim()) });
});
pSize.addEventListener('change', () => {
  const v = Number(pSize.value);
  if (v >= 6 && v <= 96) void api.invoke('apply', { ops: styleOps('fontSize', v) });
});
pBold.addEventListener('change', () => void api.invoke('apply', { ops: styleOps('bold', pBold.checked) }));
pShape.addEventListener('change', () => void api.invoke('apply', { ops: selectedIds().map((id) => ({ op: 'set_shape', id, shape: pShape.value })) }));

// ---------- 原地编辑（改名、改基数） ----------
let editing: { commit: (v: string) => void } | null = null;

function openEditor(x: number, y: number, w: number, size: number, value: string, commit: (v: string) => void): void {
  closeEditor(false);
  const p = toScreen(x, y);
  const width = Math.max(64, w * tf.s);
  editor.style.left = `${p.x - width / 2}px`;
  editor.style.top = `${p.y - (size * tf.s * 1.6) / 2}px`;
  editor.style.width = `${width}px`;
  editor.style.fontSize = `${Math.max(12, size * tf.s)}px`;
  editor.value = value;
  editor.hidden = false;
  editing = { commit };
  editor.focus();
  editor.select();
}

function closeEditor(save: boolean): void {
  if (!editing) return;
  const e = editing;
  editing = null;
  editor.hidden = true;
  if (save) e.commit(editor.value);
}

editor.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') closeEditor(true);
  else if (ev.key === 'Escape') closeEditor(false);
});
editor.addEventListener('blur', () => closeEditor(true));

function rename(id: string): void {
  const n = nodeById.get(id);
  if (!n) return;
  openEditor(n.x, n.y, n.w, n.size, n.label, (v) => {
    const t = v.trim();
    if (t && t !== n.label) void api.invoke('apply', { ops: [{ op: 'rename', id, label: t }] });
  });
}

function editCard(edgeId: string): void {
  const e = edgeById.get(edgeId);
  if (!e || e.kind !== 'rel' || !P) return;
  const at = e.card ?? { text: '', ...e.mid };
  openEditor(at.x, at.y, 40, P.style.card.size, at.text, (v) => {
    const t = v.trim();
    if (t === at.text) return;
    const k = edgeId.lastIndexOf('#');
    void api.invoke('apply', { ops: [{ op: 'set_card', relationship: edgeId.slice(0, k), end: Number(edgeId.slice(k + 1)), card: t }] });
  });
}

// ---------- 拖动、平移 ----------
interface LineRef {
  els: SVGLineElement[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  moveA: boolean;
  moveB: boolean;
  card?: SVGGElement;
}

function startDrag(ev: PointerEvent, ids: Set<string>): void {
  const start = toWorld(ev.clientX, ev.clientY);
  // 拖实体/关系时，它没被单独摆过的属性一起走（和 move 操作的规则一致）
  const moving = new Set(ids);
  for (const n of P!.nodes) if (n.owner && ids.has(n.owner) && !n.pinned) moving.add(n.id);
  const lines: LineRef[] = [];
  for (const g of vp.querySelectorAll<SVGGElement>('[data-edge]')) {
    const a = moving.has(g.dataset.from!);
    const b = moving.has(g.dataset.to!);
    if (!a && !b) continue;
    const els = [...g.querySelectorAll('line')] as SVGLineElement[];
    const l = els[0];
    lines.push({
      els,
      x1: Number(l.getAttribute('x1')),
      y1: Number(l.getAttribute('y1')),
      x2: Number(l.getAttribute('x2')),
      y2: Number(l.getAttribute('y2')),
      moveA: a,
      moveB: b,
      card: vp.querySelector<SVGGElement>(`[data-card="${CSS.escape(g.dataset.edge!)}"]`) ?? undefined,
    });
  }
  let moved = false;
  let dx = 0;
  let dy = 0;
  const onMove = (e: PointerEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    dx = p.x - start.x;
    dy = p.y - start.y;
    if (!moved && Math.hypot(dx, dy) * tf.s < 3) return;
    moved = true;
    for (const id of moving) nodeEl.get(id)?.setAttribute('transform', `translate(${dx} ${dy})`);
    for (const l of lines) {
      for (const el of l.els) {
        el.setAttribute('x1', String(l.x1 + (l.moveA ? dx : 0)));
        el.setAttribute('y1', String(l.y1 + (l.moveA ? dy : 0)));
        el.setAttribute('x2', String(l.x2 + (l.moveB ? dx : 0)));
        el.setAttribute('y2', String(l.y2 + (l.moveB ? dy : 0)));
      }
      const k = (Number(l.moveA) + Number(l.moveB)) / 2;
      l.card?.setAttribute('transform', `translate(${dx * k} ${dy * k})`);
    }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!moved) return;
    const ops: unknown[] = [];
    for (const id of ids) {
      const n = nodeById.get(id)!;
      if (n.kind === 'attribute') {
        // 属性的主人也一起拖了：它会跟着主人走，不用单独摆
        if (n.owner && ids.has(n.owner) && !n.pinned) continue;
        ops.push({ op: 'place', id, x: n.x + dx, y: n.y + dy });
      } else ops.push({ op: 'move', id, x: n.x + dx, y: n.y + dy });
    }
    void api.invoke('apply', { ops });
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startPan(ev: PointerEvent): void {
  const sx = ev.clientX;
  const sy = ev.clientY;
  const t0 = { ...tf };
  let moved = false;
  const onMove = (e: PointerEvent) => {
    if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 3) return;
    moved = true;
    tf = { ...t0, x: t0.x + e.clientX - sx, y: t0.y + e.clientY - sy };
    applyTf();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!moved) {
      // 点空白处：取消选中
      sel.clear();
      markSelection();
      updatePanel();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !P) return;
  closeEditor(true);
  const t = ev.target as Element;
  const card = t.closest<SVGGElement>('[data-card]');
  if (card) {
    editCard(card.dataset.card!);
    ev.preventDefault();
    return;
  }
  const node = t.closest<SVGGElement>('[data-node]');
  if (node) {
    const id = node.dataset.node!;
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
    } else if (!sel.has(id)) sel = new Set([id]);
    markSelection();
    updatePanel();
    if (sel.has(id)) startDrag(ev, new Set(sel));
    return;
  }
  const edge = t.closest<SVGGElement>('[data-edge]');
  if (edge && edge.dataset.kind === 'rel') {
    // 点关系线：改这条线上的基数
    editCard(edge.dataset.edge!);
    ev.preventDefault();
    return;
  }
  startPan(ev);
});

canvas.addEventListener('dblclick', (ev) => {
  const node = (ev.target as Element).closest<SVGGElement>('[data-node]');
  if (node) rename(node.dataset.node!);
});

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const t = ev.target as Element;
  const node = t.closest<SVGGElement>('[data-node]');
  if (node) {
    if (!sel.has(node.dataset.node!)) {
      sel = new Set([node.dataset.node!]);
      markSelection();
      updatePanel();
    }
    void api.invoke('contextMenu', { kind: 'node', id: node.dataset.node });
    return;
  }
  const edge = t.closest<SVGGElement>('[data-edge]') ?? (t.closest<SVGGElement>('[data-card]') ? vp.querySelector<SVGGElement>(`[data-edge="${CSS.escape(t.closest<SVGGElement>('[data-card]')!.dataset.card!)}"]`) : null);
  if (edge) void api.invoke('contextMenu', { kind: 'edge', id: edge.dataset.edge });
});

canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    closeEditor(true);
    const r = canvas.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey) zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    else {
      tf = { ...tf, x: tf.x - ev.deltaX, y: tf.y - ev.deltaY };
      applyTf();
    }
  },
  { passive: false },
);

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !editing) {
    sel.clear();
    markSelection();
    updatePanel();
  }
});
window.addEventListener('resize', () => applyTf());

// ---------- 主进程发来的 ----------
function command(c: { name: string; id?: string; factor?: number }): void {
  if (c.name === 'fit') fit();
  else if (c.name === 'zoom') {
    const r = canvas.getBoundingClientRect();
    zoomAt(c.factor ?? 1, r.width / 2, r.height / 2);
  } else if (c.name === 'selectAll') {
    if (editing) {
      editor.select();
      return;
    }
    sel = new Set(P?.nodes.map((n) => n.id) ?? []);
    markSelection();
    updatePanel();
  } else if (c.name === 'rename' && c.id) rename(c.id);
  else if (c.name === 'editCard' && c.id) editCard(c.id);
}

api.on('state', (p) => render(p as Payload));
api.on('busy', (b) => document.body.classList.toggle('busy', !!b));
api.on('command', (c) => command(c as { name: string }));

$<HTMLButtonElement>('btnOpen').addEventListener('click', () => void api.invoke('open'));
$<HTMLButtonElement>('btnGen').addEventListener('click', () => void api.invoke('generate'));

void (async () => {
  const fonts = (await api.invoke('fonts')) as string[];
  $<HTMLDataListElement>('fontList').innerHTML = fonts.map((f) => `<option value="${f.replace(/"/g, '&quot;')}"></option>`).join('');
  const p = (await api.invoke('state')) as Payload | null;
  if (p) render(p);
})();
