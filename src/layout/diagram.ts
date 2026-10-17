// 由模型 + 视图算出画面上的一切：每个节点的形状、尺寸、文字度量、位置，每条线的端点，基数标签的位置。
// 布局、核对、SVG/PNG/drawio 导出全用这一份，画出来的和核对的是同一个东西。

import type { Model } from '../model/types.js';
import type { NodeView, View } from '../model/view.js';
import { measureText } from '../text/fonts.js';
import type { Vec } from './geometry.js';
import { baseShape, defaultShape, multiLines, shapeSize, type NodeKind, type ShapeKind } from './shapes.js';

export interface DNode {
  id: string;
  kind: NodeKind;
  label: string;
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  family: string;
  size: number;
  bold: boolean;
  textW: number;
  ascent: number;
  descent: number;
  underline: 'none' | 'solid' | 'dashed';
  owner?: string; // 属性的主人（实体或关系）
  estimated: boolean;
  placed: boolean; // 视图里有坐标
}

export interface CardLabel {
  text: string;
  x: number; // 中心
  y: number;
  w: number;
  h: number;
  size: number;
  bold: boolean;
  family: string;
  ascent: number;
  descent: number;
}

export interface DEdge {
  id: string; // 关系连线：关系id#端序号；属性连线：attr:属性id
  kind: 'rel' | 'attr';
  from: string;
  to: string;
  a: Vec;
  b: Vec;
  dashed: boolean;
  card?: CardLabel;
}

export interface Diagram {
  nodes: DNode[];
  edges: DEdge[];
  byId: Map<string, DNode>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function cardText(card: string, cardCase: 'upper' | 'lower'): string {
  if (/^[A-Za-z]$/.test(card)) return cardCase === 'lower' ? card.toLowerCase() : card.toUpperCase();
  return card;
}

/** 所有节点的形状、尺寸、字体（不含位置）。 */
export function nodeBoxes(model: Model, view: View): Map<string, DNode> {
  const out = new Map<string, DNode>();
  const st = view.style;
  const make = (id: string, kind: NodeKind, label: string, flags: Parameters<typeof defaultShape>[1], underline: DNode['underline'], owner?: string) => {
    const nv: NodeView = view.nodes[id] ?? {};
    const ks = kind === 'entity' ? st.entity : kind === 'relationship' ? st.relationship : st.attribute;
    const family = nv.fontFamily ?? st.fontFamily;
    const size = nv.fontSize ?? ks.size;
    const bold = nv.bold ?? ks.bold;
    const shape = nv.shape ?? defaultShape(kind, flags);
    const m = measureText(label, family, size, bold);
    const textH = m.ascent + m.descent;
    const { w, h } = shapeSize(shape, m.width, textH, size);
    out.set(id, {
      id,
      kind,
      label,
      shape,
      x: nv.x ?? 0,
      y: nv.y ?? 0,
      w,
      h,
      family,
      size,
      bold,
      textW: m.width,
      ascent: m.ascent,
      descent: m.descent,
      underline,
      owner,
      estimated: m.estimated,
      placed: nv.x !== undefined && nv.y !== undefined,
    });
  };
  for (const e of model.entities) {
    make(e.id, 'entity', e.label, { weak: e.weak }, 'none');
    for (const a of e.attributes) make(a.id, 'attribute', a.label, { multivalued: a.multivalued, derived: a.derived }, a.key ? 'solid' : a.partialKey ? 'dashed' : 'none', e.id);
  }
  for (const r of model.relationships) {
    make(r.id, 'relationship', r.label, { identifying: r.identifying }, 'none');
    for (const a of r.attributes) make(a.id, 'attribute', a.label, { multivalued: a.multivalued, derived: a.derived }, a.key ? 'solid' : a.partialKey ? 'dashed' : 'none', r.id);
  }
  return out;
}

function inside(n: DNode, p: Vec): boolean {
  const dx = Math.abs(p.x - n.x);
  const dy = Math.abs(p.y - n.y);
  const hw = n.w / 2;
  const hh = n.h / 2;
  const b = baseShape(n.shape);
  if (b === 'rect') return dx <= hw && dy <= hh;
  if (b === 'diamond') return dx / hw + dy / hh <= 1;
  return (dx / hw) ** 2 + (dy / hh) ** 2 <= 1;
}

/** p 在形状里、q 在外面时，沿 p→q 找出边界点。 */
export function clipOut(n: DNode, p: Vec, q: Vec): Vec {
  if (!inside(n, p)) return p;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (inside(n, { x: p.x + (q.x - p.x) * m, y: p.y + (q.y - p.y) * m })) lo = m;
    else hi = m;
  }
  return { x: p.x + (q.x - p.x) * hi, y: p.y + (q.y - p.y) * hi };
}

export const CARD_T_MULTI = 0.72;

export function cardBox(text: string, family: string, size: number, bold: boolean): { w: number; h: number; ascent: number; descent: number } {
  const m = measureText(text, family, size, bold);
  return { w: m.width + 6, h: m.ascent + m.descent + 2, ascent: m.ascent, descent: m.descent };
}

export function buildDiagram(model: Model, view: View): Diagram {
  const byId = nodeBoxes(model, view);
  const edges: DEdge[] = [];
  const st = view.style;
  for (const r of model.relationships) {
    const rn = byId.get(r.id)!;
    const groups = new Map<string, number[]>();
    r.ends.forEach((e, i) => groups.set(e.entity, [...(groups.get(e.entity) ?? []), i]));
    for (const [ent, idxs] of groups) {
      const en = byId.get(ent);
      if (!en) continue;
      const lines = multiLines(en, rn, idxs.length);
      idxs.forEach((i, k) => {
        const g = lines[k];
        if (!g) return;
        const a = g.atR;
        const b = g.atE;
        const text = cardText(r.ends[i].card, st.cardCase);
        let card: CardLabel | undefined;
        if (text.trim()) {
          const cb = cardBox(text, st.fontFamily, st.card.size, st.card.bold);
          // 单线放正中；自反关系的几条线在实体端汇合、在菱形端分开，标签放在靠菱形的一侧
          const t = idxs.length > 1 ? CARD_T_MULTI : 0.5;
          card = { text, x: b.x + (a.x - b.x) * t, y: b.y + (a.y - b.y) * t, w: cb.w, h: cb.h, size: st.card.size, bold: st.card.bold, family: st.fontFamily, ascent: cb.ascent, descent: cb.descent };
        }
        edges.push({ id: `${r.id}#${i}`, kind: 'rel', from: r.id, to: ent, a, b, dashed: r.dashed, card });
      });
    }
  }
  for (const n of byId.values()) {
    if (n.kind !== 'attribute' || !n.owner) continue;
    const o = byId.get(n.owner)!;
    const a = clipOut(o, { x: o.x, y: o.y }, { x: n.x, y: n.y });
    const b = clipOut(n, { x: n.x, y: n.y }, { x: o.x, y: o.y });
    edges.push({ id: `attr:${n.id}`, kind: 'attr', from: o.id, to: n.id, a, b, dashed: false });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of byId.values()) {
    minX = Math.min(minX, n.x - n.w / 2);
    maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2);
    maxY = Math.max(maxY, n.y + n.h / 2);
  }
  for (const e of edges) {
    if (!e.card) continue;
    minX = Math.min(minX, e.card.x - e.card.w / 2);
    maxX = Math.max(maxX, e.card.x + e.card.w / 2);
    minY = Math.min(minY, e.card.y - e.card.h / 2);
    maxY = Math.max(maxY, e.card.y + e.card.h / 2);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  return { nodes: [...byId.values()], edges, byId, bounds: { minX, minY, maxX, maxY } };
}
