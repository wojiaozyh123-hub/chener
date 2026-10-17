// 节点形状：按文字算尺寸，给出多边形（外接，判重叠时只会偏保守）和连线出口点。

import { makePoly, type Poly, type Vec } from './geometry.js';

export const SHAPES = ['rect', 'double-rect', 'rounded-rect', 'diamond', 'double-diamond', 'ellipse', 'double-ellipse', 'dashed-ellipse'] as const;
export type ShapeKind = (typeof SHAPES)[number];
export type NodeKind = 'entity' | 'relationship' | 'attribute';

export const DOUBLE_GAP = 4;

export const isDouble = (s: ShapeKind) => s === 'double-rect' || s === 'double-diamond' || s === 'double-ellipse';
export const baseShape = (s: ShapeKind): 'rect' | 'diamond' | 'ellipse' =>
  s === 'diamond' || s === 'double-diamond' ? 'diamond' : s === 'ellipse' || s === 'double-ellipse' || s === 'dashed-ellipse' ? 'ellipse' : 'rect';

/** 外框尺寸（双线形状含外圈）。textW/textH 是文字宽高，size 是字号。 */
export function shapeSize(shape: ShapeKind, textW: number, textH: number, size: number): { w: number; h: number } {
  const b = baseShape(shape);
  let w: number;
  let h: number;
  if (b === 'rect') {
    w = Math.max(textW + size * 2.2, size * 4);
    h = Math.max(textH + size * 1.4, size * 2.4);
  } else if (b === 'diamond') {
    // 文字框 (X, Y) 放进 |x|/A + |y|/B ≤ 1
    const X = textW / 2 + size * 0.35;
    const Y = textH / 2 + size * 0.25;
    const B = Math.max(size * 2.1, Y * 2.4);
    const A = Math.max(X / (1 - Y / B), B * 1.45);
    w = 2 * A;
    h = 2 * B;
  } else {
    // 文字框 (X, Y) 放进椭圆 (x/a)² + (y/b)² ≤ 1；高度统一，宽度随字数
    const X = textW / 2 + size * 0.3;
    const Y = textH / 2 + size * 0.15;
    const bb = Math.max(size * 1.35, Y * 1.25);
    const a = Math.max(X / Math.sqrt(1 - (Y / bb) ** 2), size * 2.3);
    w = 2 * a;
    h = 2 * bb;
  }
  if (isDouble(shape)) {
    w += 2 * DOUBLE_GAP;
    h += 2 * DOUBLE_GAP;
  }
  return { w, h };
}

/** 以 (cx, cy) 为中心的外接多边形。 */
export function shapePoly(shape: ShapeKind, w: number, h: number, cx: number, cy: number, n = 24): Poly {
  const b = baseShape(shape);
  const hw = w / 2;
  const hh = h / 2;
  if (b === 'rect') return makePoly([{ x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh }, { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh }]);
  if (b === 'diamond') return makePoly([{ x: cx, y: cy - hh }, { x: cx + hw, y: cy }, { x: cx, y: cy + hh }, { x: cx - hw, y: cy }]);
  const k = 1 / Math.cos(Math.PI / n); // 外接：多边形包住椭圆
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * Math.PI * 2;
    pts.push({ x: cx + hw * k * Math.cos(t), y: cy + hh * k * Math.sin(t) });
  }
  return makePoly(pts);
}

/** 从中心沿单位向量 u 走到边界的距离。 */
export function boundaryDist(shape: ShapeKind, w: number, h: number, u: Vec): number {
  const b = baseShape(shape);
  const hw = w / 2;
  const hh = h / 2;
  const ax = Math.abs(u.x);
  const ay = Math.abs(u.y);
  if (b === 'rect') return Math.min(ax > 1e-12 ? hw / ax : Infinity, ay > 1e-12 ? hh / ay : Infinity);
  if (b === 'diamond') return 1 / (ax / hw + ay / hh);
  return 1 / Math.sqrt((u.x / hw) ** 2 + (u.y / hh) ** 2);
}

/** 形状在方向 u 上的半宽（支撑函数）。 */
export function support(shape: ShapeKind, w: number, h: number, u: Vec): number {
  const b = baseShape(shape);
  const hw = w / 2;
  const hh = h / 2;
  if (b === 'rect') return Math.abs(u.x) * hw + Math.abs(u.y) * hh;
  if (b === 'diamond') return Math.max(Math.abs(u.x) * hw, Math.abs(u.y) * hh);
  return Math.sqrt((hw * u.x) ** 2 + (hh * u.y) ** 2);
}

/** 从 (cx,cy) 指向 target 的连线在形状边界上的出口点。 */
export function exitPoint(shape: ShapeKind, w: number, h: number, cx: number, cy: number, target: Vec): Vec {
  const dx = target.x - cx;
  const dy = target.y - cy;
  const l = Math.hypot(dx, dy) || 1;
  const u = { x: dx / l, y: dy / l };
  const t = boundaryDist(shape, w, h, u);
  return { x: cx + u.x * t, y: cy + u.y * t };
}

export function defaultShape(kind: NodeKind, flags: { weak?: boolean; identifying?: boolean; multivalued?: boolean; derived?: boolean }): ShapeKind {
  if (kind === 'entity') return flags.weak ? 'double-rect' : 'rect';
  if (kind === 'relationship') return flags.identifying ? 'double-diamond' : 'diamond';
  if (flags.multivalued) return 'double-ellipse';
  if (flags.derived) return 'dashed-ellipse';
  return 'ellipse';
}

export function insideShape(shape: ShapeKind, w: number, h: number, dx: number, dy: number): boolean {
  const b = baseShape(shape);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (b === 'rect') return ax <= w / 2 && ay <= h / 2;
  if (b === 'diamond') return ax / (w / 2) + ay / (h / 2) <= 1;
  return (dx / (w / 2)) ** 2 + (dy / (h / 2)) ** 2 <= 1;
}

/** 相对中心的坐标：p 在形状内、q 在外，沿 p→q 找边界点。p 不在形状内时返回 p。 */
export function clipLocal(shape: ShapeKind, w: number, h: number, p: Vec, q: Vec): Vec {
  if (!insideShape(shape, w, h, p.x, p.y)) return p;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (insideShape(shape, w, h, p.x + (q.x - p.x) * m, p.y + (q.y - p.y) * m)) lo = m;
    else hi = m;
  }
  return { x: p.x + (q.x - p.x) * hi, y: p.y + (q.y - p.y) * hi };
}

/**
 * 自反关系（同一实体连同一个菱形 m 次）的第 k 条线：从实体中心出发的射线，在菱形中心处横向错开 offset。
 * 实体那端全是射线（不会和实体的其他连线、属性连线相交）；菱形那端横向分开，标签放在靠菱形的一侧。
 */
export const RECURSIVE_SEP = 40;
export function recursiveOffset(k: number, m: number): number {
  return (k - (m - 1) / 2) * RECURSIVE_SEP;
}

export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  shape: ShapeKind;
}

export interface LineGeom {
  atE: Vec; // 实体边界上的点
  atR: Vec; // 菱形边界上的点
  angle: number; // 从实体中心出发的方向
}

/** 实体 e 和关系菱形 r 之间的 m 条线（m=1 就是中心连线）。布局排扇面和最终出图都用这一个函数，两边的线完全一样。 */
export function multiLines(e: ShapeBox, r: ShapeBox, m: number): LineGeom[] {
  const dx = r.x - e.x;
  const dy = r.y - e.y;
  const D = Math.hypot(dx, dy) || 1;
  const phi = Math.atan2(dy, dx);
  const out: LineGeom[] = [];
  for (let k = 0; k < m; k++) {
    const off = recursiveOffset(k, m);
    for (const shrink of [1, 0.75, 0.5, 0.3, 0.15, 0]) {
      const o = off * shrink;
      const d = Math.atan2(o, D);
      const L = D / Math.cos(d);
      const q = { x: Math.cos(phi + d) * L, y: Math.sin(phi + d) * L }; // 相对 e 中心
      if (!insideShape(r.shape, r.w, r.h, q.x - dx, q.y - dy)) continue;
      const atE = clipLocal(e.shape, e.w, e.h, { x: 0, y: 0 }, q);
      const atR = clipLocal(r.shape, r.w, r.h, { x: q.x - dx, y: q.y - dy }, { x: -dx, y: -dy });
      out.push({ atE: { x: e.x + atE.x, y: e.y + atE.y }, atR: { x: r.x + atR.x, y: r.y + atR.y }, angle: phi + d });
      break;
    }
  }
  return out;
}
