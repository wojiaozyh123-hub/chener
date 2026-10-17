// 骨架（实体 + 关系菱形）的平面性判定和“保证不交叉”的初始画法。
//
// 1. 按双连通块拆开，每块用 DMP 算法（Demoucron–Malgrange–Pertuiset）一面一面地嵌入；嵌不进去就不是平面图。
// 2. 各块的旋转系统在割点处拼起来，得到整张图的平面嵌入。
// 3. 在嵌入里补边，先变双连通、再把每个面切成三角形（极大平面图，必然 3 连通）。
// 4. Tutte 重心画法：外面一个三角形固定，其余点放在邻居的重心。Tutte 定理保证 3 连通平面图这样画出来没有交叉。
// 5. 去掉补的边，剩下原图的边当然也不交叉。
// 不是平面图时：贪心找一个极大平面子图来画，剩下的边如实标为“无法避免的交叉”。

import type { Vec } from './geometry.js';

type Edge = [number, number];
const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

function adjacency(n: number, edges: Edge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    if (a === b || adj[a].includes(b)) continue;
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
}

/** 双连通块（每块是一组边）。 */
export function biconnectedBlocks(n: number, adj: number[][]): Edge[][] {
  const disc = new Array(n).fill(0);
  const low = new Array(n).fill(0);
  let time = 0;
  const stack: Edge[] = [];
  const blocks: Edge[][] = [];
  const dfs = (u: number, parent: number) => {
    disc[u] = low[u] = ++time;
    for (const w of adj[u]) {
      if (!disc[w]) {
        stack.push([u, w]);
        dfs(w, u);
        low[u] = Math.min(low[u], low[w]);
        if (low[w] >= disc[u]) {
          const blk: Edge[] = [];
          while (stack.length) {
            const e = stack.pop()!;
            blk.push(e);
            if (e[0] === u && e[1] === w) break;
          }
          blocks.push(blk);
        }
      } else if (w !== parent && disc[w] < disc[u]) {
        stack.push([u, w]);
        low[u] = Math.min(low[u], disc[w]);
      }
    }
  };
  for (let i = 0; i < n; i++) if (!disc[i] && adj[i].length) dfs(i, -1);
  return blocks;
}

/** DMP：双连通块的平面嵌入，返回各面（有向圈）；不是平面图返回 null。 */
function dmp(blockEdges: Edge[]): number[][] | null {
  const verts = [...new Set(blockEdges.flat())];
  const adj = new Map<number, number[]>(verts.map((v) => [v, []]));
  for (const [a, b] of blockEdges) {
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  if (blockEdges.length === 1) return null; // 单边块由调用方处理

  // 找一个圈
  const parent = new Map<number, number>();
  const depth = new Map<number, number>();
  let cycle: number[] | null = null;
  parent.set(verts[0], -1);
  depth.set(verts[0], 0);
  const visit = (u: number): boolean => {
    for (const w of adj.get(u)!) {
      if (w === parent.get(u)) continue;
      if (depth.has(w)) {
        if (depth.get(w)! < depth.get(u)!) {
          const c: number[] = [u];
          let x = u;
          while (x !== w) {
            x = parent.get(x)!;
            c.push(x);
          }
          cycle = c.reverse();
          return true;
        }
        continue;
      }
      parent.set(w, u);
      depth.set(w, depth.get(u)! + 1);
      if (visit(w)) return true;
    }
    return false;
  };
  visit(verts[0]);
  if (!cycle) return null;
  const cyc: number[] = cycle;

  const inH = new Set<number>(cyc);
  const hEdges = new Set<string>();
  for (let i = 0; i < cyc.length; i++) hEdges.add(key(cyc[i], cyc[(i + 1) % cyc.length]));
  let faces: number[][] = [cyc.slice(), cyc.slice().reverse()];

  while (hEdges.size < blockEdges.length) {
    // 碎片
    interface Frag {
      attach: number[];
      path: () => number[];
    }
    const frags: Frag[] = [];
    for (const [a, b] of blockEdges) {
      if (!hEdges.has(key(a, b)) && inH.has(a) && inH.has(b)) frags.push({ attach: [a, b], path: () => [a, b] });
    }
    const seen = new Set<number>();
    for (const s of verts) {
      if (inH.has(s) || seen.has(s)) continue;
      const comp: number[] = [];
      const q = [s];
      seen.add(s);
      while (q.length) {
        const x = q.shift()!;
        comp.push(x);
        for (const y of adj.get(x)!) if (!inH.has(y) && !seen.has(y)) {
          seen.add(y);
          q.push(y);
        }
      }
      const compSet = new Set(comp);
      const attach = [...new Set(comp.flatMap((x) => adj.get(x)!.filter((y) => inH.has(y))))];
      frags.push({
        attach,
        path: () => {
          const a0 = attach[0];
          const c0 = comp.find((x) => adj.get(x)!.includes(a0))!;
          const prev = new Map<number, number>([[c0, -1]]);
          const qq = [c0];
          while (qq.length) {
            const x = qq.shift()!;
            const b = adj.get(x)!.find((y) => inH.has(y) && y !== a0);
            if (b !== undefined) {
              const p: number[] = [b, x];
              let k = x;
              while (prev.get(k)! !== -1) {
                k = prev.get(k)!;
                p.push(k);
              }
              p.push(a0);
              return p.reverse();
            }
            for (const y of adj.get(x)!) if (compSet.has(y) && !prev.has(y)) {
              prev.set(y, x);
              qq.push(y);
            }
          }
          throw new Error('DMP: 碎片里找不到第二个连接点');
        },
      });
    }
    let chosen: { frag: Frag; face: number[] } | null = null;
    let bestCount = Infinity;
    for (const f of frags) {
      const adm = faces.filter((face) => f.attach.every((a) => face.includes(a)));
      if (adm.length === 0) return null; // 不是平面图
      if (adm.length < bestCount) {
        bestCount = adm.length;
        chosen = { frag: f, face: adm[0] };
        if (adm.length === 1) break;
      }
    }
    if (!chosen) break;
    const path = chosen.frag.path();
    const face = chosen.face;
    const a = path[0];
    const b = path[path.length - 1];
    const i = face.indexOf(a);
    const j = face.indexOf(b);
    const inner = path.slice(1, -1);
    const walk = (from: number, to: number) => {
      const out: number[] = [];
      let k = from;
      for (;;) {
        out.push(face[k]);
        if (k === to) break;
        k = (k + 1) % face.length;
      }
      return out;
    };
    const f1 = [...walk(i, j), ...inner.slice().reverse()];
    const f2 = [...walk(j, i), ...inner];
    faces = faces.filter((x) => x !== face);
    faces.push(f1, f2);
    for (const x of inner) inH.add(x);
    for (let k = 0; k + 1 < path.length; k++) hEdges.add(key(path[k], path[k + 1]));
  }
  return faces;
}

/** 旋转系统：rot[v] 是 v 的邻居的循环序列。约定：有向边 u→v 之后的面上一条边是 v→before_v(u)。 */
export class Embedding {
  rot: number[][];
  constructor(n: number) {
    this.rot = Array.from({ length: n }, () => []);
  }
  before(v: number, u: number): number {
    const r = this.rot[v];
    const i = r.indexOf(u);
    return r[(i - 1 + r.length) % r.length];
  }
  has(a: number, b: number): boolean {
    return this.rot[a].includes(b);
  }
  /** 面上有 a→b→c 时，在这个面里加弦 a–c。 */
  addChord(a: number, b: number, c: number): void {
    const ra = this.rot[a];
    ra.splice(ra.indexOf(b) + 1, 0, c);
    const rc = this.rot[c];
    rc.splice(rc.indexOf(b), 0, a);
  }
  edges(): Edge[] {
    const out: Edge[] = [];
    this.rot.forEach((r, v) => r.forEach((u) => v < u && out.push([v, u])));
    return out;
  }
  faces(): number[][] {
    const seen = new Set<string>();
    const out: number[][] = [];
    for (let u = 0; u < this.rot.length; u++) {
      for (const v of this.rot[u]) {
        if (seen.has(`${u}>${v}`)) continue;
        const face: number[] = [];
        let a = u;
        let b = v;
        for (let guard = 0; guard < 100000; guard++) {
          seen.add(`${a}>${b}`);
          face.push(a);
          const c = this.before(b, a);
          a = b;
          b = c;
          if (a === u && b === v) break;
        }
        out.push(face);
      }
    }
    return out;
  }
}

/** 由各双连通块的面拼出整张图的旋转系统。不是平面图返回 null。 */
function embed(n: number, edges: Edge[]): Embedding | null {
  const adj = adjacency(n, edges);
  const blocks = biconnectedBlocks(n, adj);
  const emb = new Embedding(n);
  for (const blk of blocks) {
    if (blk.length === 1) {
      const [a, b] = blk[0];
      emb.rot[a].push(b);
      emb.rot[b].push(a);
      continue;
    }
    const faces = dmp(blk);
    if (!faces) return null;
    // 面里每个角 u→v→w：在 v 处 w 紧挨在 u 前面
    const succ = new Map<number, Map<number, number>>();
    for (const f of faces) {
      for (let i = 0; i < f.length; i++) {
        const u = f[(i - 1 + f.length) % f.length];
        const vv = f[i];
        const w = f[(i + 1) % f.length];
        if (!succ.has(vv)) succ.set(vv, new Map());
        succ.get(vv)!.set(w, u);
      }
    }
    for (const [vv, m] of succ) {
      const start = m.keys().next().value as number;
      const order: number[] = [start];
      let x = m.get(start)!;
      while (x !== start && order.length <= m.size) {
        order.push(x);
        x = m.get(x)!;
      }
      if (order.length !== m.size) throw new Error('平面嵌入的旋转系统不一致');
      emb.rot[vv].push(...order);
    }
  }
  return emb;
}

export function isPlanar(n: number, edges: Edge[]): boolean {
  return embed(n, edges) !== null;
}

function blockIdOfEdges(n: number, emb: Embedding): Map<string, number> {
  const adj = emb.rot.map((r) => [...r]);
  const blocks = biconnectedBlocks(n, adj);
  const m = new Map<string, number>();
  blocks.forEach((blk, i) => blk.forEach(([a, b]) => m.set(key(a, b), i)));
  return m;
}

/** 在嵌入里补边变成双连通（每个面都是简单圈）。只在已知面里加弦，所以始终是平面的、没有重边。 */
function makeBiconnected(n: number, emb: Embedding): void {
  for (let guard = 0; guard < 10 * n + 10; guard++) {
    const bid = blockIdOfEdges(n, emb);
    if (new Set(bid.values()).size <= 1) break;
    let done = false;
    for (let vtx = 0; vtx < n && !done; vtx++) {
      for (const u of emb.rot[vtx]) {
        const w = emb.before(vtx, u);
        if (w === u) continue;
        if (bid.get(key(vtx, u)) !== bid.get(key(vtx, w))) {
          emb.addChord(u, vtx, w); // 面上有 u→vtx→w
          done = true;
          break;
        }
      }
    }
    if (!done) break;
  }
}

/** 把除外面以外的每个面切成三角形。外面用它上面的一条有向边认出来。 */
function triangulateInner(n: number, emb: Embedding, outerA: number, outerB: number): void {
  const isOuter = (f: number[]) => f.some((x, i) => x === outerA && f[(i + 1) % f.length] === outerB);
  for (let guard = 0; guard < 6 * n + 10; guard++) {
    const big = emb.faces().find((f) => f.length > 3 && !isOuter(f));
    if (!big) return;
    const k = big.length;
    let added = false;
    for (let i = 0; i < k; i++) {
      const a = big[i];
      const b = big[(i + 1) % k];
      const c = big[(i + 2) % k];
      if (a !== c && !emb.has(a, c)) {
        emb.addChord(a, b, c);
        added = true;
        break;
      }
    }
    if (!added) throw new Error('三角化失败：面上找不到可加的弦');
  }
}

/** 解稠密线性方程组（高斯消元，部分主元）。 */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * 重心画法：外圈的点均匀摆在圆上（严格凸多边形），其余点放在邻居的重心。
 * 内部全是三角形、外圈严格凸时，画出来没有交叉（Tutte 定理 / Floater 2003）。外圈点越多，内部越不挤。
 */
function tutte(n: number, emb: Embedding, outer: number[]): Vec[] {
  const pos: Vec[] = new Array(n);
  const R = 1000;
  outer.forEach((v, i) => {
    const t = Math.PI / 2 + (i * 2 * Math.PI) / outer.length;
    pos[v] = { x: R * Math.cos(t), y: -R * Math.sin(t) };
  });
  const fixed = new Set(outer);
  const inner = [...Array(n).keys()].filter((v) => !fixed.has(v));
  const idx = new Map(inner.map((v, i) => [v, i] as const));
  const m = inner.length;
  if (m) {
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const bx = new Array(m).fill(0);
    const by = new Array(m).fill(0);
    for (const vtx of inner) {
      const i = idx.get(vtx)!;
      const nb = emb.rot[vtx];
      A[i][i] = nb.length;
      for (const u of nb) {
        if (fixed.has(u)) {
          bx[i] += pos[u].x;
          by[i] += pos[u].y;
        } else A[i][idx.get(u)!] -= 1;
      }
    }
    const xs = solve(A, bx);
    const ys = solve(A, by);
    inner.forEach((vtx, i) => (pos[vtx] = { x: xs[i], y: ys[i] }));
  }
  return pos;
}

export interface PlanarDrawing {
  pos: Vec[];
  planar: boolean;
  /** 不是平面图时，没能放进平面子图的边（会交叉） */
  leftover: Edge[];
}

/** 连通图的平面直线画法。faceChoice 选外面那个三角形（多起点时换着用）。 */
export function planarDrawing(n: number, edges: Edge[], faceChoice = 0, orderSeed = 0): PlanarDrawing {
  const simple: Edge[] = [];
  const seen = new Set<string>();
  for (const [a, b] of edges) {
    if (a === b || seen.has(key(a, b))) continue;
    seen.add(key(a, b));
    simple.push([a, b]);
  }
  if (n === 1) return { pos: [{ x: 0, y: 0 }], planar: true, leftover: [] };
  if (n === 2) return { pos: [{ x: -500, y: 0 }, { x: 500, y: 0 }], planar: true, leftover: [] };

  let use = simple;
  const leftover: Edge[] = [];
  let emb = embed(n, simple);
  if (!emb) {
    // 贪心极大平面子图：按调用方给的顺序（重要的边在前）逐条放，放不进的留下
    use = [];
    const order = simple.slice();
    if (orderSeed) {
      let x = orderSeed * 2654435761;
      for (let i = order.length - 1; i > 0; i--) {
        x = (x * 1103515245 + 12345) >>> 0;
        const j = x % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    for (const e of order) {
      if (embed(n, [...use, e])) use.push(e);
      else leftover.push(e);
    }
    emb = embed(n, use)!;
  }
  makeBiconnected(n, emb);
  // 外圈选最大的面（换起点时轮换前几大的面）
  const faces = emb.faces().sort((a, b) => b.length - a.length);
  const outer = faces[faceChoice % Math.min(3, faces.length)];
  triangulateInner(n, emb, outer[0], outer[1]);
  return { pos: tutte(n, emb, outer), planar: leftover.length === 0, leftover };
}
