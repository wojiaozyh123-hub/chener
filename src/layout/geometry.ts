// 平面几何：线段、凸多边形的相交与距离。布局和核对都只用这一套判定。

export interface Vec {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
export const len = (a: Vec) => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

// 以下距离/相交函数在布局和核对里会被调用上千万次，全部用标量写，不创建临时对象。

function psd(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const l2 = abx * abx + aby * aby;
  let t = l2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / l2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

export function pointSegDist(p: Vec, a: Vec, b: Vec): number {
  return psd(p.x, p.y, a.x, a.y, b.x, b.y);
}

function orientXY(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegXY(px: number, py: number, qx: number, qy: number, rx: number, ry: number, eps: number): boolean {
  return Math.min(px, qx) - eps <= rx && rx <= Math.max(px, qx) + eps && Math.min(py, qy) - eps <= ry && ry <= Math.max(py, qy) + eps;
}

function segsIntersectXY(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, eps = 1e-9): boolean {
  const d1 = orientXY(cx, cy, dx, dy, ax, ay);
  const d2 = orientXY(cx, cy, dx, dy, bx, by);
  const d3 = orientXY(ax, ay, bx, by, cx, cy);
  const d4 = orientXY(ax, ay, bx, by, dx, dy);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  if (Math.abs(d1) <= eps && onSegXY(cx, cy, dx, dy, ax, ay, eps)) return true;
  if (Math.abs(d2) <= eps && onSegXY(cx, cy, dx, dy, bx, by, eps)) return true;
  if (Math.abs(d3) <= eps && onSegXY(ax, ay, bx, by, cx, cy, eps)) return true;
  if (Math.abs(d4) <= eps && onSegXY(ax, ay, bx, by, dx, dy, eps)) return true;
  return false;
}

/** 两线段是否相交（含端点接触、共线重叠）。 */
export function segsIntersect(a: Vec, b: Vec, c: Vec, d: Vec, eps = 1e-9): boolean {
  return segsIntersectXY(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y, eps);
}

function ssd(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segsIntersectXY(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(psd(ax, ay, cx, cy, dx, dy), psd(bx, by, cx, cy, dx, dy), psd(cx, cy, ax, ay, bx, by), psd(dx, dy, ax, ay, bx, by));
}

export function segSegDist(a: Vec, b: Vec, c: Vec, d: Vec): number {
  return ssd(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
}

/** 点在凸多边形内（含边界）。多边形顶点顺序任意方向。 */
export function pointInConvex(p: Vec, poly: Vec[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = orientXY(a.x, a.y, b.x, b.y, p.x, p.y);
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface Poly {
  pts: Vec[];
  cx: number;
  cy: number;
  r: number; // 外接圆半径，用来快速排除
}

export function makePoly(pts: Vec[]): Poly {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
  return { pts, cx, cy, r };
}

export function translatePoly(p: Poly, dx: number, dy: number): Poly {
  return { pts: p.pts.map((q) => ({ x: q.x + dx, y: q.y + dy })), cx: p.cx + dx, cy: p.cy + dy, r: p.r };
}

/** 两段的包围盒之间的距离（下界），用来跳过明显离得远的边对。 */
function boxGap(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const gx = Math.max(0, Math.min(cx, dx) - Math.max(ax, bx), Math.min(ax, bx) - Math.max(cx, dx));
  const gy = Math.max(0, Math.min(cy, dy) - Math.max(ay, by), Math.min(ay, by) - Math.max(cy, dy));
  return Math.sqrt(gx * gx + gy * gy);
}

/**
 * 两个凸多边形之间的距离；重叠为 0。
 * limit：调用方只关心“是否小于 limit”。一旦确定小于 limit 就提前返回（返回值 < limit，但不一定是最小值）；
 * 确定大于等于 limit 时返回的也只是一个 ≥ limit 的值。
 */
export function polyPolyDist(P: Poly, Q: Poly, limit = Infinity): number {
  const centerGap = Math.hypot(P.cx - Q.cx, P.cy - Q.cy) - P.r - Q.r;
  if (centerGap >= limit) return centerGap;
  if (pointInConvex(P.pts[0], Q.pts) || pointInConvex(Q.pts[0], P.pts)) return 0;
  let best = Infinity;
  const n = P.pts.length;
  const m = Q.pts.length;
  for (let i = 0; i < n; i++) {
    const a = P.pts[i];
    const b = P.pts[(i + 1) % n];
    for (let j = 0; j < m; j++) {
      const c = Q.pts[j];
      const d = Q.pts[(j + 1) % m];
      if (boxGap(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y) >= Math.min(best, limit)) continue;
      const dd = ssd(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
      if (dd < best) {
        best = dd;
        if (best === 0 || best < limit) return best;
      }
    }
  }
  return best === Infinity ? Math.max(limit, centerGap) : best;
}

/** 线段到凸多边形的距离；穿过或在内部为 0。limit 的含义同 polyPolyDist。 */
export function segPolyDist(a: Vec, b: Vec, P: Poly, limit = Infinity): number {
  const quick = psd(P.cx, P.cy, a.x, a.y, b.x, b.y) - P.r;
  if (quick >= limit) return quick;
  if (pointInConvex(a, P.pts) || pointInConvex(b, P.pts)) return 0;
  let best = Infinity;
  const n = P.pts.length;
  for (let i = 0; i < n; i++) {
    const c = P.pts[i];
    const d = P.pts[(i + 1) % n];
    if (boxGap(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y) >= Math.min(best, limit)) continue;
    const dd = ssd(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
    if (dd < best) {
      best = dd;
      if (best === 0 || best < limit) return best;
    }
  }
  return best === Infinity ? Math.max(limit, quick) : best;
}

/** 两线段的交点（假定确实相交且不平行）。 */
export function segIntersection(a: Vec, b: Vec, c: Vec, d: Vec): Vec | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(c, a), s) / den;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/** 两线段上最近的两点（Ericson《Real-Time Collision Detection》5.1.9）。s、t 是参数，d 是距离。 */
export function segClosest(p1: Vec, q1: Vec, p2: Vec, q2: Vec): { s: number; t: number; d: number; ax: number; ay: number; bx: number; by: number } {
  const d1x = q1.x - p1.x;
  const d1y = q1.y - p1.y;
  const d2x = q2.x - p2.x;
  const d2y = q2.y - p2.y;
  const rx = p1.x - p2.x;
  const ry = p1.y - p2.y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  let s = 0;
  let t = 0;
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0;
  } else if (a <= 1e-12) {
    t = clamp(f / e);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= 1e-12) {
      s = clamp(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const ax = p1.x + d1x * s;
  const ay = p1.y + d1y * s;
  const bx = p2.x + d2x * t;
  const by = p2.y + d2y * t;
  return { s, t, d: Math.hypot(ax - bx, ay - by), ax, ay, bx, by };
}
