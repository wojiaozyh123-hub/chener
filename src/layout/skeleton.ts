// 骨架排布：把每个实体/关系连同它的一圈属性看成一个圆盘，在“绝不产生新交叉”的约束下用力导向拉匀。
//
// 不交叉的保证（PrEd / ImPrEd 的思路）：每一步之前算出所有“必须保持分开”的对象之间的余量 g
//   圆盘—圆盘、圆盘—不相连的边、边—不相邻的边；
// 每个点这一步最多移动 g/2.2（取它参与的所有约束里的最小值）。两样东西的距离一步之内最多变化两者位移之和 < g，
// 所以余量始终为正：开始时没有交叉、没有压盖，整个过程里都不会有。

import { dist, pointSegDist, segClosest, segSegDist, segsIntersect, type Vec } from './geometry.js';

export interface SkNode {
  r: number; // 圆盘半径（节点 + 它的属性）
  pinned: boolean;
  diamond2?: [number, number]; // 两端的关系菱形：轻轻拉向两端中点，让线接近一条直线
}

export interface SkEdge {
  a: number;
  b: number;
  len: number; // 理想长度（圆心距）
  free: boolean; // 非平面图里放不进平面子图的边：允许交叉，不参与约束
}

export interface SkOpts {
  margin: number; // 圆盘之间
  edgeMargin: number; // 圆盘与不相连的边之间
  edgeGap: number; // 不相邻的边之间
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 应力优化（SMACOF）：让画面距离接近图上的最短路距离。只当作候选起点，交叉与否另行检查。 */
export function stressLayout(n: number, edges: SkEdge[], seed: number): Vec[] {
  const INF = 1e18;
  const d: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): number => (i === j ? 0 : INF)));
  for (const e of edges) {
    d[e.a][e.b] = Math.min(d[e.a][e.b], e.len);
    d[e.b][e.a] = Math.min(d[e.b][e.a], e.len);
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  const rand = rng(seed);
  const scale = Math.max(...edges.map((e) => e.len), 100);
  const p: Vec[] = Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2 + rand() * 0.8;
    const r = scale * (1 + rand());
    return { x: r * Math.cos(t), y: r * Math.sin(t) };
  });
  for (let it = 0; it < 300; it++) {
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let j = 0; j < n; j++) {
        if (i === j || d[i][j] >= INF) continue;
        const w = 1 / (d[i][j] * d[i][j]);
        const dd = dist(p[i], p[j]) || 1e-6;
        sx += w * (p[j].x + (d[i][j] * (p[i].x - p[j].x)) / dd);
        sy += w * (p[j].y + (d[i][j] * (p[i].y - p[j].y)) / dd);
        sw += w;
      }
      if (sw > 0) p[i] = { x: sx / sw, y: sy / sw };
    }
  }
  return p;
}

export function crossingPairs(pos: Vec[], edges: SkEdge[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i];
      const f = edges[j];
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      if (segsIntersect(pos[e.a], pos[e.b], pos[f.a], pos[f.b])) out.push([i, j]);
    }
  }
  return out;
}

interface Pairs {
  nn: [number, number][];
  ne: [number, number][]; // [节点, 边]
  ee: [number, number][];
  neSoft: [number, number][]; // 节点和“允许交叉的边”：只推开、不限速（它们本来就可能交叉，没有不变量可守）
}

function buildPairs(n: number, edges: SkEdge[]): Pairs {
  const nn: [number, number][] = [];
  const ne: [number, number][] = [];
  const ee: [number, number][] = [];
  const neSoft: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) nn.push([i, j]);
  edges.forEach((e, k) => {
    for (let i = 0; i < n; i++) if (i !== e.a && i !== e.b) (e.free ? neSoft : ne).push([i, k]);
  });
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i];
      const f = edges[j];
      if (e.free || f.free) continue;
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      ee.push([i, j]);
    }
  }
  return { nn, ne, ee, neSoft };
}

/** 等比例缩放，让最紧的约束刚好留出 5% 余量。缩放不改变角度，所以属性扇面排出来不变。 */
export function scaleToClear(pos: Vec[], nodes: SkNode[], edges: SkEdge[], o: SkOpts): Vec[] {
  const n = pos.length;
  if (n <= 1) return pos.map((p) => ({ ...p }));
  const { nn, ne, ee } = buildPairs(n, edges);
  let s = 0;
  for (const [i, j] of nn) {
    const d = dist(pos[i], pos[j]);
    s = Math.max(s, (nodes[i].r + nodes[j].r + o.margin) / Math.max(d, 1e-9));
  }
  for (const [k, ei] of ne) {
    const e = edges[ei];
    const d = pointSegDist(pos[k], pos[e.a], pos[e.b]);
    s = Math.max(s, (nodes[k].r + o.edgeMargin) / Math.max(d, 1e-9));
  }
  for (const [a, b] of ee) {
    const e = edges[a];
    const f = edges[b];
    const d = segSegDist(pos[e.a], pos[e.b], pos[f.a], pos[f.b]);
    if (d > 0) s = Math.max(s, o.edgeGap / d);
  }
  s *= 1.05;
  const cx = pos.reduce((a, p) => a + p.x, 0) / n;
  const cy = pos.reduce((a, p) => a + p.y, 0) / n;
  return pos.map((p) => ({ x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s }));
}

/** 约束力导向。返回新位置；输入必须已经满足所有约束（先 scaleToClear）。 */
/**
 * soft：从用户摆的位置出发时，开局就已经违反的约束（用户把两个东西拖到了一起）无法守住，
 * 这些约束只留推开力、不再限速；其余约束照常保证不产生新的交叉和压盖。
 */
export function refine(pos0: Vec[], nodes: SkNode[], edges: SkEdge[], o: SkOpts, iters: number, repel = 0, soft = false, gravity = 0.003): Vec[] {
  const n = pos0.length;
  const p = pos0.map((q) => ({ ...q }));
  if (n <= 1) return p;
  const { nn, ne, ee, neSoft } = buildPairs(n, edges);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const q of p) {
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  }
  let T = Math.max(20, Math.hypot(maxX - minX, maxY - minY) * 0.05);
  const ks = 0.08;
  const kr = 3;
  const ke = 2;
  const kg = gravity; // 收尾时调大：外围的簇往中间靠，空白收掉（约束保证不会因此交叉或压盖）
  const kd = 0.06;
  const kee = 2;
  // 三类约束各有对应的推开力：圆盘—圆盘、圆盘—边、边—边。少了哪一类，贴得太近的那一对就永远分不开，整张图会被它卡住。
  const rangeNE = Math.max(50, repel * 0.3);
  const rangeEE = Math.max(40, repel * 0.25);
  let quiet = 0;
  const F: Vec[] = p.map(() => ({ x: 0, y: 0 }));
  const M = new Array(n).fill(Infinity);
  const dropNN = new Set<number>();
  const dropNE = new Set<number>();
  const dropEE = new Set<number>();
  if (soft) {
    nn.forEach(([i, j], k) => {
      if (dist(p[i], p[j]) - nodes[i].r - nodes[j].r - o.margin <= 0) dropNN.add(k);
    });
    ne.forEach(([k, ei], q) => {
      if (pointSegDist(p[k], p[edges[ei].a], p[edges[ei].b]) - nodes[k].r - o.edgeMargin <= 0) dropNE.add(q);
    });
    ee.forEach(([a, b], q) => {
      if (segSegDist(p[edges[a].a], p[edges[a].b], p[edges[b].a], p[edges[b].b]) - o.edgeGap <= 0) dropEE.add(q);
    });
  }

  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      F[i].x = 0;
      F[i].y = 0;
      M[i] = Infinity;
    }
    for (const e of edges) {
      const dx = p[e.b].x - p[e.a].x;
      const dy = p[e.b].y - p[e.a].y;
      const d = Math.hypot(dx, dy) || 1e-6;
      // 必然交叉的边拉力减半：它的两端之间隔着整个平面结构，硬拽只会把两端顶死在别的约束上，整张图收不拢
      const f = (e.free ? ks * 0.5 : ks) * (d - e.len);
      F[e.a].x += (dx / d) * f;
      F[e.a].y += (dy / d) * f;
      F[e.b].x -= (dx / d) * f;
      F[e.b].y -= (dy / d) * f;
    }
    let cx = 0;
    let cy = 0;
    for (const q of p) {
      cx += q.x;
      cy += q.y;
    }
    cx /= n;
    cy /= n;
    for (let i = 0; i < n; i++) {
      F[i].x += (cx - p[i].x) * kg;
      F[i].y += (cy - p[i].y) * kg;
      const d2 = nodes[i].diamond2;
      if (d2) {
        F[i].x += ((p[d2[0]].x + p[d2[1]].x) / 2 - p[i].x) * kd;
        F[i].y += ((p[d2[0]].y + p[d2[1]].y) / 2 - p[i].y) * kd;
      }
    }
    for (let q = 0; q < nn.length; q++) {
      const [i, j] = nn[q];
      const dx = p[j].x - p[i].x;
      const dy = p[j].y - p[i].y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const need = nodes[i].r + nodes[j].r + o.margin;
      const g = d - need;
      if (!dropNN.has(q)) {
        M[i] = Math.min(M[i], g / 2.2);
        M[j] = Math.min(M[j], g / 2.2);
      }
      const range = Math.max(need * 0.6, repel);
      if (g < range) {
        // 越近推得越狠，余量趋近 0 时推力趋于无穷：任何一对都不会被弹簧拉到贴住
        const f = kr * (range / Math.max(g, range * 1e-9) - 1);
        F[i].x -= (dx / d) * f;
        F[i].y -= (dy / d) * f;
        F[j].x += (dx / d) * f;
        F[j].y += (dy / d) * f;
      }
    }
    for (let q = 0; q < ne.length; q++) {
      const [k, ei] = ne[q];
      const e = edges[ei];
      const a = p[e.a];
      const b = p[e.b];
      const ab = { x: b.x - a.x, y: b.y - a.y };
      const l2 = ab.x * ab.x + ab.y * ab.y || 1e-9;
      const t = Math.max(0, Math.min(1, ((p[k].x - a.x) * ab.x + (p[k].y - a.y) * ab.y) / l2));
      const c = { x: a.x + ab.x * t, y: a.y + ab.y * t };
      const dx = p[k].x - c.x;
      const dy = p[k].y - c.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const g = d - nodes[k].r - o.edgeMargin;
      const lim = g / 2.2;
      if (!dropNE.has(q)) {
        if (lim < M[k]) M[k] = lim;
        if (lim < M[e.a]) M[e.a] = lim;
        if (lim < M[e.b]) M[e.b] = lim;
      }
      if (g < rangeNE) {
        const f = ke * (rangeNE / Math.max(g, rangeNE * 1e-9) - 1);
        F[k].x += (dx / d) * f;
        F[k].y += (dy / d) * f;
        F[e.a].x -= (dx / d) * f * (1 - t);
        F[e.a].y -= (dy / d) * f * (1 - t);
        F[e.b].x -= (dx / d) * f * t;
        F[e.b].y -= (dy / d) * f * t;
      }
    }
    for (let q = 0; q < ee.length; q++) {
      const [ai, bi] = ee[q];
      const e = edges[ai];
      const f = edges[bi];
      const c = segClosest(p[e.a], p[e.b], p[f.a], p[f.b]);
      const g = c.d - o.edgeGap;
      const lim = g / 2.2;
      if (!dropEE.has(q)) for (const v of [e.a, e.b, f.a, f.b]) if (lim < M[v]) M[v] = lim;
      if (g < rangeEE && c.d > 1e-12) {
        const ux = (c.ax - c.bx) / c.d;
        const uy = (c.ay - c.by) / c.d;
        const k = kee * (rangeEE / Math.max(g, rangeEE * 1e-9) - 1);
        F[e.a].x += ux * k * (1 - c.s);
        F[e.a].y += uy * k * (1 - c.s);
        F[e.b].x += ux * k * c.s;
        F[e.b].y += uy * k * c.s;
        F[f.a].x -= ux * k * (1 - c.t);
        F[f.a].y -= uy * k * (1 - c.t);
        F[f.b].x -= ux * k * c.t;
        F[f.b].y -= uy * k * c.t;
      }
    }
    for (const [k, ei] of neSoft) {
      const e = edges[ei];
      const a = p[e.a];
      const b = p[e.b];
      const ab = { x: b.x - a.x, y: b.y - a.y };
      const l2 = ab.x * ab.x + ab.y * ab.y || 1e-9;
      const t = Math.max(0, Math.min(1, ((p[k].x - a.x) * ab.x + (p[k].y - a.y) * ab.y) / l2));
      const dx = p[k].x - (a.x + ab.x * t);
      const dy = p[k].y - (a.y + ab.y * t);
      const d = Math.hypot(dx, dy) || 1e-6;
      const g = d - nodes[k].r - o.edgeMargin;
      if (g < rangeNE) {
        const f = Math.min(ke * (rangeNE / Math.max(g, 1) - 1), 50);
        F[k].x += (dx / d) * f;
        F[k].y += (dy / d) * f;
      }
    }
    let maxMove = 0;
    for (let i = 0; i < n; i++) {
      if (nodes[i].pinned) continue;
      const l = Math.hypot(F[i].x, F[i].y);
      if (l === 0) continue;
      const cap = Math.max(0, Math.min(M[i], T));
      const k = l > cap ? cap / l : 1;
      p[i].x += F[i].x * k;
      p[i].y += F[i].y * k;
      maxMove = Math.max(maxMove, l * k);
    }
    T = Math.max(T * 0.992, 0.5);
    if (maxMove < 0.05) {
      if (++quiet > 25) break;
    } else quiet = 0;
  }
  return p;
}

/** 选一个旋转角，让整体（含圆盘）的外框面积小、宽高比接近横版 16:10。 */
export function landscapeRotation(pos: Vec[], radii: number[]): number {
  let best = 0;
  let bestScore = Infinity;
  for (let deg = 0; deg < 180; deg += 5) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    pos.forEach((q, i) => {
      const x = q.x * c - q.y * s;
      const y = q.x * s + q.y * c;
      minX = Math.min(minX, x - radii[i]);
      maxX = Math.max(maxX, x + radii[i]);
      minY = Math.min(minY, y - radii[i]);
      maxY = Math.max(maxY, y + radii[i]);
    });
    const w = maxX - minX;
    const h = maxY - minY;
    const aspect = w / h;
    const pen = aspect < 1.4 ? (1.4 / aspect) ** 1.5 : aspect > 2.2 ? aspect / 2.2 : 1;
    const score = w * h * pen;
    if (score < bestScore - 1e-6) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

export function rotate(pos: Vec[], t: number): Vec[] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return pos.map((q) => ({ x: q.x * c - q.y * s, y: q.x * s + q.y * c }));
}

/** 分辨率：最紧的约束余量 / 平均边长。点模式摊匀要把它拉到一定程度再放大，否则放大倍数由最挤的那一处决定。 */
export function resolution(pos: Vec[], edges: SkEdge[], meanLen: number): number {
  const n = pos.length;
  const { nn, ne, ee } = buildPairs(n, edges);
  let m = Infinity;
  for (const [i, j] of nn) m = Math.min(m, dist(pos[i], pos[j]));
  for (const [k, ei] of ne) m = Math.min(m, pointSegDist(pos[k], pos[edges[ei].a], pos[edges[ei].b]));
  for (const [a, b] of ee) m = Math.min(m, segSegDist(pos[edges[a].a], pos[edges[a].b], pos[edges[b].a], pos[edges[b].b]));
  return m / meanLen;
}
