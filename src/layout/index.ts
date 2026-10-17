// 布局总流程：
//   骨架（实体 + 关系菱形）按连通分量分开排；每个分量多起点（平面画法 ×2、应力画法 ×2），取最紧凑的结果。
//   每个起点：缩放到满足约束 → 约束力导向拉匀 → 旋转成横版 → 按实际连线方向排属性扇面 → 用扇面真实半径更新圆盘 → 再缩放……
//   最后一步总是“排扇面 → 等比缩放”，缩放不改角度，扇面依然成立，所以结果一定满足全部约束。
//   分量之间按行排开。

import type { Model } from '../model/types.js';
import type { View } from '../model/view.js';
import { cardBox, cardText, nodeBoxes, type DNode } from './diagram.js';
import { packFan, type FanItem, type FanLine, type FanResult } from './fans.js';
import type { Vec } from './geometry.js';
import { planarDrawing } from './planar.js';
import { multiLines, shapePoly } from './shapes.js';
import { crossingPairs, landscapeRotation, refine, resolution, rotate, scaleToClear, stressLayout, type SkEdge, type SkNode, type SkOpts } from './skeleton.js';

export interface LayoutReport {
  components: number;
  planar: boolean;
  /** 骨架不是平面图时，必然交叉的连线（关系 id —— 实体 id） */
  forcedCrossings: { relationship: string; entity: string }[];
  fanFailures: string[];
}

const OPTS: SkOpts = { margin: 16, edgeMargin: 12, edgeGap: 14 };
const OPTS_POINT: SkOpts = { margin: 0, edgeMargin: 0, edgeGap: 0 }; // 摊匀阶段只管不交叉：余量必须是 0，Tutte 画法里挤在一起的点间距可能远小于 1px，给绝对余量会一开始就违反约束、把点冻住
const FAN = { gap: 6, spokeGap: 4, spoke0: 24, ringStep: 0 };
const L0 = 56; // 圆盘之间连线的理想可见长度
const START = (200 * Math.PI) / 180;

interface CompEdge {
  a: number; // 关系（局部下标）
  b: number; // 实体
  mult: number; // 同一关系连这个实体几次（自反关系 ≥ 2）
  clear: number;
  relId: string;
  entId: string;
}

interface CompResult {
  pos: Vec[];
  fans: FanResult[];
  score: number;
  forced: number[]; // free 边的下标
}

export interface LayoutOptions {
  /** 整理：从当前位置出发，拖过的（pinned）节点和属性不动，其余在约束下理顺；没有位置的新节点放在邻居旁边 */
  keep?: boolean;
}

export function layoutModel(model: Model, view: View, opts: LayoutOptions = {}): { view: View; report: LayoutReport } {
  const boxes = nodeBoxes(model, view);
  const skelIds = [...model.entities.map((e) => e.id), ...model.relationships.map((r) => r.id)];
  const index = new Map(skelIds.map((id, i) => [id, i] as const));
  const leavesOf = new Map<string, string[]>();
  for (const e of model.entities) leavesOf.set(e.id, e.attributes.map((a) => a.id));
  for (const r of model.relationships) leavesOf.set(r.id, r.attributes.map((a) => a.id));
  const st = view.style;
  const maxLeafH = Math.max(0, ...[...boxes.values()].filter((b) => b.kind === 'attribute').map((b) => b.h));
  const fanParams = { ...FAN, ringStep: maxLeafH * 0.7 + 8 };

  // 骨架边：每个关系到每个（不同的）实体一条；同一实体出现多次（自反关系）画成并行线，留更宽的空隙
  const allEdges: { a: number; b: number; mult: number; clear: number; relId: string; entId: string }[] = [];
  for (const r of model.relationships) {
    const groups = new Map<string, string[]>();
    for (const e of r.ends) groups.set(e.entity, [...(groups.get(e.entity) ?? []), cardText(e.card, st.cardCase)]);
    for (const [ent, cards] of groups) {
      if (!index.has(ent)) continue;
      const lab = Math.max(0, ...cards.map((c) => {
        const b = cardBox(c, st.fontFamily, st.card.size, st.card.bold);
        return Math.hypot(b.w, b.h) / 2;
      }));
      const clear = Math.max(12, lab + 4);
      allEdges.push({ a: index.get(r.id)!, b: index.get(ent)!, mult: cards.length, clear, relId: r.id, entId: ent });
    }
  }

  // 连通分量
  const parent = skelIds.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of allEdges) parent[find(e.a)] = find(e.b);
  const comps = new Map<number, number[]>();
  skelIds.forEach((_, i) => comps.set(find(i), [...(comps.get(find(i)) ?? []), i]));

  const report: LayoutReport = { components: comps.size, planar: true, forcedCrossings: [], fanFailures: [] };
  const placedComps: { ids: number[]; pos: Vec[]; fans: FanResult[]; bbox: { minX: number; minY: number; maxX: number; maxY: number }; kept?: boolean }[] = [];
  const at = (id: string): Vec | null => {
    const nv = view.nodes[id];
    return nv && nv.x !== undefined && nv.y !== undefined ? { x: nv.x, y: nv.y } : null;
  };

  // 整理时，所有已经摆在画面上的分量放在一起理（互相要避让）；没有位置的分量单独新排
  let groupsToLay: { members: number[]; keep: boolean }[] = [...comps.values()].map((m) => ({ members: m, keep: false }));
  if (opts.keep) {
    const keptMembers = groupsToLay.filter((g) => g.members.some((i) => at(skelIds[i]))).flatMap((g) => g.members);
    groupsToLay = [...(keptMembers.length ? [{ members: keptMembers, keep: true }] : []), ...groupsToLay.filter((g) => !g.members.some((i) => at(skelIds[i])))];
  }
  for (const { members, keep } of groupsToLay) {
    const local = new Map(members.map((g, i) => [g, i] as const));
    const edges: CompEdge[] = allEdges.filter((e) => local.has(e.a)).map((e) => ({ ...e, a: local.get(e.a)!, b: local.get(e.b)! }));
    const centers: FanItem[] = members.map((g) => {
      const b = boxes.get(skelIds[g])!;
      return { w: b.w, h: b.h, shape: b.shape };
    });
    const leaves: FanItem[][] = members.map((g) => (leavesOf.get(skelIds[g]) ?? []).map((id) => {
      const b = boxes.get(id)!;
      return { w: b.w, h: b.h, shape: b.shape };
    }));
    const ids = members.map((g) => skelIds[g]);
    const res = keep
      ? tidyComponent(edges, centers, leaves, fanParams, ids, model, ids.map((id) => at(id)), ids.map((id) => !!view.nodes[id]?.pinned), ids.map((id) => (leavesOf.get(id) ?? []).map((aid) => (view.nodes[aid]?.pinned ? at(aid) : null))))
      : layoutComponent(members.length, edges, centers, leaves, fanParams, ids, model);
    for (const fi of res.forced) {
      report.planar = false;
      report.forcedCrossings.push({ relationship: edges[fi].relId, entity: edges[fi].entId });
    }
    res.fans.forEach((f, i) => {
      if (!f.ok) report.fanFailures.push(skelIds[members[i]]);
    });
    placedComps.push({ ids: members, pos: res.pos, fans: res.fans, bbox: compBBox(res.pos, res.fans, ids, boxes, leavesOf), kept: keep });
  }

  // 整理时保留的分量原地不动；新排的分量按面积从大到小，一行一行排（整理时排在已有内容右边）
  const nodes = { ...view.nodes };
  const writeComp = (c: (typeof placedComps)[number], dx: number, dy: number, keepPins: boolean) => {
    c.ids.forEach((g, i) => {
      const id = skelIds[g];
      const p = c.pos[i];
      nodes[id] = { ...nodes[id], x: round(p.x + dx), y: round(p.y + dy), pinned: keepPins ? nodes[id]?.pinned : undefined };
      (leavesOf.get(id) ?? []).forEach((aid, k) => {
        const o = c.fans[i].offsets[k];
        nodes[aid] = { ...nodes[aid], x: round(p.x + dx + o.x), y: round(p.y + dy + o.y), pinned: keepPins ? nodes[aid]?.pinned : undefined };
      });
    });
  };
  const kept = placedComps.filter((c) => c.kept);
  for (const c of kept) writeComp(c, 0, 0, true);
  const fresh = placedComps.filter((c) => !c.kept).sort((a, b) => area(b.bbox) - area(a.bbox));
  const GAP = 80;
  const totalArea = fresh.reduce((s, c) => s + area(c.bbox), 0);
  const maxW = Math.max(...fresh.map((c) => c.bbox.maxX - c.bbox.minX), 0);
  const rowLimit = Math.max(maxW, Math.sqrt(totalArea) * 1.6);
  const keptMaxX = kept.length ? Math.max(...kept.map((c) => c.bbox.maxX)) + GAP : 0;
  const keptMinY = kept.length ? Math.min(...kept.map((c) => c.bbox.minY)) : 0;
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const c of fresh) {
    const w = c.bbox.maxX - c.bbox.minX;
    const h = c.bbox.maxY - c.bbox.minY;
    if (x > 0 && x + w > rowLimit) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    writeComp(c, keptMaxX + x - c.bbox.minX, keptMinY + y - c.bbox.minY, false);
    x += w + GAP;
    rowH = Math.max(rowH, h);
  }
  for (const k of Object.keys(nodes)) {
    if (nodes[k].pinned === undefined) delete nodes[k].pinned;
  }
  return { view: { ...view, nodes }, report };
}

const round = (v: number) => Math.round(v * 10) / 10;
const area = (b: { minX: number; minY: number; maxX: number; maxY: number }) => (b.maxX - b.minX) * (b.maxY - b.minY);

function compBBox(pos: Vec[], fans: FanResult[], ids: string[], boxes: Map<string, DNode>, leavesOf: Map<string, string[]>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const addBox = (cx: number, cy: number, w: number, h: number) => {
    minX = Math.min(minX, cx - w / 2);
    maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - h / 2);
    maxY = Math.max(maxY, cy + h / 2);
  };
  ids.forEach((id, i) => {
    const b = boxes.get(id)!;
    addBox(pos[i].x, pos[i].y, b.w, b.h);
    (leavesOf.get(id) ?? []).forEach((aid, k) => {
      const lb = boxes.get(aid)!;
      const o = fans[i].offsets[k] ?? { x: 0, y: 0 };
      addBox(pos[i].x + o.x, pos[i].y + o.y, lb.w, lb.h);
    });
  });
  return { minX, minY, maxX, maxY };
}

/** 每个节点身上的连线（相对它自己中心的坐标）都和最终出图用同一个 multiLines；fixedAbs 是用户摆过的属性的绝对位置。 */
function makePackAll(edges: CompEdge[], centers: FanItem[], leaves: FanItem[][], fp: typeof FAN, fixedAbs?: (Vec | null)[][]) {
  return (pos: Vec[]): FanResult[] => {
    const lines: FanLine[][] = centers.map(() => []);
    for (const e of edges) {
      const rb = { x: pos[e.a].x, y: pos[e.a].y, ...centers[e.a] };
      const eb = { x: pos[e.b].x, y: pos[e.b].y, ...centers[e.b] };
      for (const g of multiLines(eb, rb, e.mult)) {
        lines[e.b].push({ a: { x: g.atE.x - eb.x, y: g.atE.y - eb.y }, b: { x: g.atR.x - eb.x, y: g.atR.y - eb.y }, angle: g.angle, clear: e.clear });
        lines[e.a].push({ a: { x: g.atR.x - rb.x, y: g.atR.y - rb.y }, b: { x: g.atE.x - rb.x, y: g.atE.y - rb.y }, angle: Math.atan2(g.atE.y - g.atR.y, g.atE.x - g.atR.x), clear: e.clear });
      }
    }
    return centers.map((c, i) => {
      const fixed = (fixedAbs?.[i] ?? []).map((f) => (f ? { x: f.x - pos[i].x, y: f.y - pos[i].y } : null));
      return packFan(c, lines[i], leaves[i], fp, START, fixed);
    });
  };
}

/** 整理：从当前位置出发。拖过的节点不动；没有位置的新节点放到已摆好的邻居旁边；开局就冲突的约束只推开、不限速。 */
function tidyComponent(edges: CompEdge[], centers: FanItem[], leaves: FanItem[][], fp: typeof FAN, ids: string[], model: Model, start: (Vec | null)[], pinned: boolean[], fixedAbs: (Vec | null)[][]): CompResult {
  const n = ids.length;
  const pos: Vec[] = start.map((p) => (p ? { ...p } : { x: NaN, y: NaN }));
  const placedPts = pos.filter((p) => !Number.isNaN(p.x));
  const cx = placedPts.reduce((a, p) => a + p.x, 0) / Math.max(1, placedPts.length);
  const cy = placedPts.reduce((a, p) => a + p.y, 0) / Math.max(1, placedPts.length);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    pos.forEach((p, i) => {
      if (!Number.isNaN(p.x)) return;
      const nb = edges.filter((e) => e.a === i || e.b === i).map((e) => (e.a === i ? e.b : e.a)).filter((j) => !Number.isNaN(pos[j].x));
      if (!nb.length && pass < n - 1) return;
      const bx = nb.length ? nb.reduce((a, j) => a + pos[j].x, 0) / nb.length : cx;
      const by = nb.length ? nb.reduce((a, j) => a + pos[j].y, 0) / nb.length : cy;
      const t = (i * 2.399) % (Math.PI * 2);
      pos[i] = { x: bx + Math.cos(t) * 160, y: by + Math.sin(t) * 160 };
      changed = true;
    });
    if (!changed && pos.every((p) => !Number.isNaN(p.x))) break;
  }
  const packAll = makePackAll(edges, centers, leaves, fp, fixedAbs);
  const relIds = new Set(model.relationships.map((r) => r.id));
  const nbrs: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (!nbrs[e.a].includes(e.b)) nbrs[e.a].push(e.b);
    if (!nbrs[e.b].includes(e.a)) nbrs[e.b].push(e.a);
  }
  const mkNodes = (R: number[]): SkNode[] => R.map((r, i) => ({ r, pinned: pinned[i], diamond2: relIds.has(ids[i]) && nbrs[i].length === 2 ? ([nbrs[i][0], nbrs[i][1]] as [number, number]) : undefined }));
  const kOf = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  let fans = packAll(pos);
  let R = fans.map((f) => f.radius + 2);
  const mk = (R: number[], free: Set<string>): SkEdge[] => edges.map((e) => ({ a: e.a, b: e.b, len: R[e.a] + R[e.b] + L0, free: free.has(kOf(e.a, e.b)) }));
  untangle(pos, edges, R, pinned, nbrs, (v) => relIds.has(ids[v]));
  fans = packAll(pos);
  R = fans.map((f) => f.radius + 2);
  // 还剩下的交叉：这些边允许交叉（守不住），其余照常不产生新交叉
  const free = new Set<string>();
  for (const [i, j] of crossingPairs(pos, mk(R, free))) {
    free.add(kOf(edges[i].a, edges[i].b));
    free.add(kOf(edges[j].a, edges[j].b));
  }
  let p = n > 1 ? refine(pos, mkNodes(R), mk(R, free), OPTS, 600, 0, true) : pos;
  fans = packAll(p);
  R = fans.map((f) => f.radius + 2);
  if (n > 1) {
    p = refine(p, mkNodes(R), mk(R, free), OPTS, 300, 0, true);
    fans = packAll(p);
  }
  return { pos: p, fans, score: 0, forced: [] };
}

/**
 * 解交叉：连续移动不会改变点在线的哪一侧，解不开已有的交叉（拖走实体后留在原地的菱形、应力画法里的交叉）。
 * 让卷进交叉、没被固定的节点“跳”到邻居中间附近：交叉变少、又不压到别的圆盘和线才接受。关系菱形优先跳。
 */
function untangle(pos: Vec[], edges: CompEdge[], R: number[], pinned: boolean[], nbrs: number[][], isRel: (v: number) => boolean, checkFit = true): void {
  const n = pos.length;
  const all: SkEdge[] = edges.map((e) => ({ a: e.a, b: e.b, len: 0, free: false }));
  const crossCount = (P: Vec[]) => crossingPairs(P, all).length;
  // checkFit=false：应力画法本来就不管簇大小、簇之间早已叠着，这一步只解交叉；间距由后面的“摊匀 → 放大”负责
  const fits = (P: Vec[], v: number) => {
    if (!checkFit) {
      for (let u = 0; u < n; u++) if (u !== v && Math.hypot(P[u].x - P[v].x, P[u].y - P[v].y) < 1) return false;
      return true;
    }
    for (let u = 0; u < n; u++) if (u !== v && Math.hypot(P[u].x - P[v].x, P[u].y - P[v].y) < R[u] + R[v] + OPTS.margin) return false;
    for (const e of all) {
      if (e.a === v || e.b === v) continue;
      const ax = P[e.a].x, ay = P[e.a].y, bx = P[e.b].x, by = P[e.b].y;
      const l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1e-9;
      const t = Math.max(0, Math.min(1, ((P[v].x - ax) * (bx - ax) + (P[v].y - ay) * (by - ay)) / l2));
      if (Math.hypot(P[v].x - ax - (bx - ax) * t, P[v].y - ay - (by - ay) * t) < R[v] + OPTS.edgeMargin) return false;
    }
    return true;
  };
  for (let pass = 0; pass < 6; pass++) {
    if (!crossCount(pos)) return;
    const involved = new Set<number>();
    for (const [i, j] of crossingPairs(pos, all)) for (const e of [all[i], all[j]]) for (const v of [e.a, e.b]) if (!pinned[v]) involved.add(v);
    let improved = false;
    for (const v of [...involved].sort((a, b) => Number(isRel(b)) - Number(isRel(a)))) {
      const nb = nbrs[v];
      if (!nb.length) continue;
      const bx = nb.reduce((a, j) => a + pos[j].x, 0) / nb.length;
      const by = nb.reduce((a, j) => a + pos[j].y, 0) / nb.length;
      const cur = crossCount(pos);
      let done = false;
      for (const r of [0, 60, 120, 200, 320, 480]) {
        for (let k = 0; k < (r ? 12 : 1) && !done; k++) {
          const t = (k / 12) * Math.PI * 2;
          const trial = pos.slice();
          trial[v] = { x: bx + Math.cos(t) * r, y: by + Math.sin(t) * r };
          if (crossCount(trial) < cur && fits(trial, v)) {
            pos[v] = trial[v];
            done = improved = true;
          }
        }
        if (done) break;
      }
    }
    if (!improved) return;
  }
}

function layoutComponent(n: number, edges: CompEdge[], centers: FanItem[], leaves: FanItem[][], fp: typeof FAN, ids: string[], model: Model): CompResult {
  const packAll = makePackAll(edges, centers, leaves, fp);

  if (n === 1) {
    const pos = [{ x: 0, y: 0 }];
    return { pos, fans: packAll(pos), score: 0, forced: [] };
  }

  const relIds = new Set(model.relationships.map((r) => r.id));
  const nbrs: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (!nbrs[e.a].includes(e.b)) nbrs[e.a].push(e.b);
    if (!nbrs[e.b].includes(e.a)) nbrs[e.b].push(e.a);
  }
  const R0 = centers.map((c, i) => packFan(c, [], leaves[i], fp, START).radius + 2);
  const mkNodes = (R: number[], zero = false): SkNode[] =>
    R.map((r, i) => ({ r: zero ? 0 : r, pinned: false, diamond2: relIds.has(ids[i]) && nbrs[i].length === 2 ? ([nbrs[i][0], nbrs[i][1]] as [number, number]) : undefined }));
  const pairs = edges.map((e) => [e.a, e.b] as [number, number]);
  const kOf = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const mkEdges = (R: number[], free: Set<string>): SkEdge[] => edges.map((e) => ({ a: e.a, b: e.b, len: R[e.a] + R[e.b] + L0, free: free.has(kOf(e.a, e.b)) }));

  // 候选起点：每个起点带着自己的“允许交叉的边”集合（平面图为空）
  const starts: { pos: Vec[]; free: Set<string> }[] = [];
  const pd0 = planarDrawing(n, pairs, 0);
  if (pd0.planar) {
    starts.push({ pos: pd0.pos, free: new Set() });
    for (let f = 1; f < (n >= 4 ? 4 : 1); f++) starts.push({ pos: planarDrawing(n, pairs, f).pos, free: new Set() });
  } else {
    // 不是平面图：换几种顺序取极大平面子图，留下的边不同，最后挑交叉最少的
    for (const seed of [0, 1, 2, 3]) {
      const pd = seed === 0 ? pd0 : planarDrawing(n, pairs, 0, seed);
      starts.push({ pos: pd.pos, free: new Set(pd.leftover.map(([a, b]) => kOf(a, b))) });
    }
  }
  const sk0 = mkEdges(R0, new Set());
  for (const seed of [7, 19]) {
    const s = stressLayout(n, sk0, seed);
    // 应力画法通常最紧凑，但常带几处交叉：先跳点解开；还剩的，贪心去掉交叉最多的边，剩下的必须不交叉
    untangle(s, edges, R0, new Array(n).fill(false), nbrs, (v) => relIds.has(ids[v]), false);
    const free = new Set<string>();
    for (;;) {
      const sk = mkEdges(R0, free).filter((e) => !e.free);
      const cp = crossingPairs(s, sk);
      if (!cp.length) break;
      const cnt = new Map<string, number>();
      for (const [i, j] of cp) for (const e of [sk[i], sk[j]]) cnt.set(kOf(e.a, e.b), (cnt.get(kOf(e.a, e.b)) ?? 0) + 1);
      free.add([...cnt.entries()].sort((x, y) => y[1] - x[1])[0][0]);
    }
    if (pd0.planar ? free.size === 0 : free.size <= pd0.leftover.length + 1) starts.push({ pos: s, free });
  }

  // 兜底：万一所有起点都有交叉（数值退化），把第一个起点里实际交叉的边标成允许交叉，照常排；交叉会如实出现在核对报告里
  {
    const free0 = new Set(starts[0].free);
    for (const [i, j] of crossingPairs(starts[0].pos, mkEdges(R0, free0).filter((e) => !e.free))) {
      free0.add(kOf(edges[i].a, edges[i].b));
      free0.add(kOf(edges[j].a, edges[j].b));
    }
    if (free0.size > starts[0].free.size) starts.push({ pos: starts[0].pos, free: free0 });
  }
  const meanLen = sk0.reduce((a, e) => a + e.len, 0) / Math.max(1, sk0.length);
  let best: (CompResult & { crossings: number }) | null = null;
  for (const st of starts) {
    let R = R0.slice();
    let sk = mkEdges(R, st.free);
    if (crossingPairs(st.pos, sk.filter((e) => !e.free)).length) continue; // 起点本身必须不交叉
    // 1. 点模式摊匀（Tutte 画法里挤成一团的点先分开），同样不产生交叉
    let pos = st.pos;
    for (let chunk = 0; chunk < 10; chunk++) {
      pos = refine(pos, mkNodes(R, true), sk, OPTS_POINT, 300, meanLen);
      if (resolution(pos, sk, meanLen) >= 0.04) break;
    }
    // 2. 放大到圆盘放得下，再在约束下拉匀、转成横版
    pos = scaleToClear(pos, mkNodes(R), sk, OPTS);
    let fans: FanResult[] = [];
    for (let round = 0; round < 4; round++) {
      // 迭代数：照护样本上 1 倍时收紧没收敛（得分 7.6M），3 倍到 4.5M；再多收益不再单调增加
      pos = refine(pos, mkNodes(R), sk, OPTS, round === 0 ? 3000 : 1200, 0, false, round >= 2 ? 0.02 : 0.003);
      if (round === 0) pos = rotate(pos, landscapeRotation(pos, R));
      fans = packAll(pos);
      R = fans.map((f) => f.radius + 2);
      sk = mkEdges(R, st.free);
      pos = scaleToClear(pos, mkNodes(R), sk, OPTS);
    }
    // 3. 最终复核：按最终位置重排扇面，半径没超出圆盘才算数，超了就再放大
    for (let it = 0; it < 4; it++) {
      fans = packAll(pos);
      const newR = fans.map((f) => f.radius + 2);
      if (newR.every((r, i) => r <= R[i] + 0.5)) break;
      R = R.map((r, i) => Math.max(r, newR[i]));
      sk = mkEdges(R, st.free);
      pos = scaleToClear(pos, mkNodes(R), sk, OPTS);
    }
    const crossings = crossingPairs(pos, sk).length;
    const score = scoreOf(pos, fans, centers, leaves);
    if (!best || crossings < best.crossings || (crossings === best.crossings && score < best.score)) {
      best = { pos, fans, score, crossings, forced: sk.map((e, i) => (e.free ? i : -1)).filter((i) => i >= 0) };
    }
  }
  return best!;
}

function scoreOf(pos: Vec[], fans: FanResult[], centers: FanItem[], leaves: FanItem[][]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  pos.forEach((p, i) => {
    const polys = [shapePoly(centers[i].shape, centers[i].w, centers[i].h, p.x, p.y, 8)];
    leaves[i].forEach((l, k) => polys.push(shapePoly(l.shape, l.w, l.h, p.x + fans[i].offsets[k].x, p.y + fans[i].offsets[k].y, 8)));
    for (const poly of polys) for (const q of poly.pts) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
  });
  const w = maxX - minX;
  const h = maxY - minY;
  const aspect = w / h;
  const pen = aspect < 1.3 ? (1.3 / aspect) ** 1.5 : aspect > 2.3 ? aspect / 2.3 : 1;
  return w * h * pen;
}
