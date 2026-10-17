// 属性扇面：把一个实体（或关系）的属性椭圆摆在它周围、骨架连线之间的空档里。
//
// 属性只连自己的主人，所以只要满足下面几条，就不可能产生交叉：
//   椭圆不碰主人、不碰别的椭圆；每根属性连线不穿过别的椭圆；椭圆离主人的骨架连线至少 clear（给基数标签留位）。
// 先尽量单圈摆；摆不下就允许错开成两三圈（示例图里“用户”的 12 个属性就是这样）；还不行就把连线拉长一点。
// 最后在各自空档里把角度拉匀。

import { polyPolyDist, segPolyDist, segSegDist, translatePoly, type Poly, type Vec } from './geometry.js';
import { boundaryDist, shapePoly, support, type ShapeKind } from './shapes.js';

export interface FanItem {
  w: number;
  h: number;
  shape: ShapeKind;
}

/** 主人身上连出去的一条线（相对主人中心的坐标）。普通连线是从边界出发的射线；自反关系菱形那端不是射线，按真实线段给。 */
export interface FanLine {
  a: Vec; // 线在主人边界上的出口
  b: Vec; // 远端
  angle: number; // 大致方向（弧度，屏幕坐标 y 向下），用来分空档
  clear: number; // 椭圆离这条线至少多远（给基数标签留位）
}

export function rayLine(center: FanItem, angle: number, clear: number): FanLine {
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const d = boundaryDist(center.shape, center.w, center.h, u);
  return { a: { x: u.x * d, y: u.y * d }, b: { x: u.x * 6000, y: u.y * 6000 }, angle, clear };
}

export interface FanParams {
  gap: number; // 形状之间
  spokeGap: number; // 连线与别的椭圆之间
  spoke0: number; // 第一圈连线的可见长度
  ringStep: number; // 圈与圈的距离
}

export interface FanResult {
  offsets: Vec[]; // 相对主人中心
  radius: number; // 主人中心到最远一点
  ok: boolean;
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const ORIGIN: Vec = { x: 0, y: 0 };

interface Placed {
  i: number;
  theta: number;
  ring: number;
  c: Vec;
  poly: Poly;
  gap: number;
}

const SPOKE_LINE_GAP = 2; // 属性连线和主人的其他连线在出口附近至少隔开这么多

export function packFan(center: FanItem, dirs: FanLine[], leaves: FanItem[], P: FanParams, startAngle = 200 * DEG): FanResult {
  const cPoly = shapePoly(center.shape, center.w, center.h, 0, 0, 24);
  const cR = cPoly.r;
  if (!leaves.length) return { offsets: [], radius: cR, ok: true };
  const lPolys = leaves.map((l) => shapePoly(l.shape, l.w, l.h, 0, 0, 20));

  // 空档
  const norm = (a: number) => ((a % TAU) + TAU) % TAU;
  let gaps: { start: number; end: number }[];
  if (!dirs.length) gaps = [{ start: startAngle, end: startAngle + TAU }];
  else {
    const as = [...new Set(dirs.map((d) => norm(d.angle)))].sort((a, b) => a - b);
    gaps = as.map((a, k) => ({ start: a, end: k + 1 < as.length ? as[k + 1] : as[0] + TAU }));
    const s = norm(startAngle);
    const first = gaps.findIndex((g) => (s >= g.start && s < g.end) || (s + TAU >= g.start && s + TAU < g.end));
    if (first > 0) gaps = [...gaps.slice(first), ...gaps.slice(0, first)];
  }
  const full = !dirs.length;

  const centerAt = (i: number, theta: number, ring: number, spoke0: number): Vec => {
    const u = { x: Math.cos(theta), y: Math.sin(theta) };
    const dc = boundaryDist(center.shape, center.w, center.h, u);
    const dl = support(leaves[i].shape, leaves[i].w, leaves[i].h, u);
    const rho = dc + spoke0 + dl + ring * P.ringStep;
    return { x: u.x * rho, y: u.y * rho };
  };

  const spokeStart = (c: Vec): Vec => {
    const l = Math.hypot(c.x, c.y) || 1;
    const u = { x: c.x / l, y: c.y / l };
    const d = boundaryDist(center.shape, center.w, center.h, u);
    return { x: u.x * d, y: u.y * d };
  };

  const validAt = (i: number, c: Vec, poly: Poly, placed: Placed[], skip: number): boolean => {
    if (polyPolyDist(poly, cPoly, P.gap) < P.gap) return false;
    const s0 = spokeStart(c);
    for (const r of dirs) {
      if (segPolyDist(r.a, r.b, poly, r.clear) < r.clear) return false;
      if (segSegDist(s0, c, r.a, r.b) < SPOKE_LINE_GAP) return false;
    }
    for (const q of placed) {
      if (q.i === skip) continue;
      if (polyPolyDist(poly, q.poly, P.gap) < P.gap) return false;
      if (segPolyDist(ORIGIN, c, q.poly, P.spokeGap) < P.spokeGap) return false;
      if (segPolyDist(ORIGIN, q.c, poly, P.spokeGap) < P.spokeGap) return false;
    }
    return true;
  };

  const tryAt = (i: number, theta: number, ring: number, spoke0: number, placed: Placed[], skip = -1) => {
    const c = centerAt(i, theta, ring, spoke0);
    const poly = translatePoly(lPolys[i], c.x, c.y);
    return validAt(i, c, poly, placed, skip) ? { c, poly } : null;
  };

  /** 在 [from, to) 里找最小的可行角度：粗扫 2°，再二分细化。 */
  const scan = (i: number, ring: number, from: number, to: number, spoke0: number, placed: Placed[]): number | null => {
    const step = 2 * DEG;
    let prev = from;
    for (let t = from + 0.5 * DEG; t < to; t += step) {
      if (tryAt(i, t, ring, spoke0, placed)) {
        let lo = prev;
        let hi = t;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2;
          if (mid > from && tryAt(i, mid, ring, spoke0, placed)) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prev = t;
    }
    return null;
  };

  // 每个空档分几个：按角度大小
  const sizes = gaps.map((g) => g.end - g.start);
  const usable = sizes.map((s) => (s >= 22 * DEG ? s : 0));
  const total = usable.reduce((a, b) => a + b, 0) || 1;
  const raw = usable.map((s) => (s / total) * leaves.length);
  const quota = raw.map(Math.floor);
  let rest = leaves.length - quota.reduce((a, b) => a + b, 0);
  const order = raw.map((r, k) => [r - Math.floor(r), k] as const).sort((a, b) => b[0] - a[0]);
  for (const [, k] of order) {
    if (rest <= 0) break;
    if (usable[k] > 0) {
      quota[k]++;
      rest--;
    }
  }

  const attempt = (maxRing: number, spoke0: number): Placed[] | null => {
    const placed: Placed[] = [];
    let idx = 0;
    let carry = 0;
    for (let gi = 0; gi < gaps.length && idx < leaves.length; gi++) {
      const g = gaps[gi];
      const want = quota[gi] + carry;
      let cursor = g.start;
      let got = 0;
      while (idx < leaves.length && got < want) {
        let best: { theta: number; ring: number } | null = null;
        for (let ring = 0; ring <= maxRing; ring++) {
          const limit = best ? best.theta : g.end;
          const t = scan(idx, ring, cursor, limit, spoke0, placed);
          if (t !== null && (!best || t < best.theta - 1e-9)) best = { theta: t, ring };
        }
        if (!best) break;
        const at = tryAt(idx, best.theta, best.ring, spoke0, placed)!;
        placed.push({ i: idx, theta: best.theta, ring: best.ring, c: at.c, poly: at.poly, gap: gi });
        cursor = best.theta;
        idx++;
        got++;
      }
      carry = want - got;
    }
    // 配额没对上时：剩下的在任何空档里找位置
    while (idx < leaves.length) {
      let done = false;
      for (let gi = 0; gi < gaps.length && !done; gi++) {
        for (let ring = 0; ring <= maxRing && !done; ring++) {
          const t = scan(idx, ring, gaps[gi].start, gaps[gi].end, spoke0, placed);
          if (t !== null) {
            const at = tryAt(idx, t, ring, spoke0, placed)!;
            placed.push({ i: idx, theta: t, ring, c: at.c, poly: at.poly, gap: gi });
            done = true;
          }
        }
      }
      if (!done) return null;
      idx++;
    }
    return placed;
  };

  let placed: Placed[] | null = null;
  let usedSpoke = P.spoke0;
  outer: for (let grow = 0; grow < 12; grow++) {
    const spoke0 = P.spoke0 + grow * 16;
    for (let maxRing = 0; maxRing <= 2; maxRing++) {
      placed = attempt(maxRing, spoke0);
      if (placed) {
        usedSpoke = spoke0;
        break outer;
      }
    }
  }
  if (!placed) return { offsets: leaves.map(() => ({ x: 0, y: 0 })), radius: cR, ok: false };

  // 在各自空档里把角度拉匀；能往里收一圈就收
  for (let iter = 0; iter < 40; iter++) {
    let moved = false;
    for (let gi = 0; gi < gaps.length; gi++) {
      const g = gaps[gi];
      const list = placed.filter((q) => q.gap === gi).sort((a, b) => a.theta - b.theta);
      for (let k = 0; k < list.length; k++) {
        const q = list[k];
        let lo: number;
        let hi: number;
        if (full) {
          lo = k > 0 ? list[k - 1].theta : list[list.length - 1].theta - TAU;
          hi = k + 1 < list.length ? list[k + 1].theta : list[0].theta + TAU;
          if (list.length === 1) {
            lo = q.theta;
            hi = q.theta;
          }
        } else {
          lo = k > 0 ? list[k - 1].theta : g.start;
          hi = k + 1 < list.length ? list[k + 1].theta : g.end;
        }
        const target = (lo + hi) / 2;
        if (Math.abs(target - q.theta) < 0.2 * DEG && q.ring === 0) continue;
        let applied = false;
        for (const frac of [1, 0.5, 0.25]) {
          const t = q.theta + (target - q.theta) * frac;
          for (const ring of q.ring > 0 ? [q.ring - 1, q.ring] : [q.ring]) {
            const at = tryAt(q.i, t, ring, usedSpoke, placed, q.i);
            if (at) {
              if (Math.abs(t - q.theta) > 0.05 * DEG || ring !== q.ring) moved = true;
              q.theta = t;
              q.ring = ring;
              q.c = at.c;
              q.poly = at.poly;
              applied = true;
              break;
            }
          }
          if (applied) break;
        }
      }
    }
    if (!moved) break;
  }

  const offsets: Vec[] = new Array(leaves.length);
  let radius = cR;
  for (const q of placed) {
    offsets[q.i] = q.c;
    radius = Math.max(radius, Math.hypot(q.c.x, q.c.y) + q.poly.r);
  }
  return { offsets, radius, ok: true };
}
