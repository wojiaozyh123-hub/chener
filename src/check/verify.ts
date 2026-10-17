// 核对：在最终画面上逐项精确判定，并核对“每一列都有去处”“agent 给的证据真实存在”。
// 全部没有错误才算通过。这里的判定不依赖布局算法，只看结果。

import fs from 'node:fs';
import path from 'node:path';
import type { FactSet, Issue } from '../facts/types.js';
import { lower } from '../facts/types.js';
import type { Diagram } from '../layout/diagram.js';
import { makePoly, polyPolyDist, segPolyDist, segsIntersect, segIntersection, type Poly, type Vec } from '../layout/geometry.js';
import { shapePoly } from '../layout/shapes.js';
import type { Ledger, Model } from '../model/types.js';

export interface GeometryProblem {
  kind: 'crossing' | 'overlap' | 'line-through-node' | 'label-overlap' | 'unplaced' | 'canvas';
  ids: string[];
  message: string;
  at?: Vec;
}

export interface CheckReport {
  ok: boolean;
  errors: number;
  warnings: number;
  geometry: GeometryProblem[];
  issues: Issue[];
  stats: { entities: number; relationships: number; attributes: number; columns: number; columnsShown: number; columnsAsRelationship: number; columnsExcluded: number };
}

const NODE_GAP = 2; // 形状之间至少 2px
const LINE_NODE_GAP = 1.5;

function labelPoly(c: { x: number; y: number; w: number; h: number }): Poly {
  const hw = c.w / 2;
  const hh = c.h / 2;
  return makePoly([{ x: c.x - hw, y: c.y - hh }, { x: c.x + hw, y: c.y - hh }, { x: c.x + hw, y: c.y + hh }, { x: c.x - hw, y: c.y + hh }]);
}

export function checkGeometry(d: Diagram): GeometryProblem[] {
  const out: GeometryProblem[] = [];
  const nodes = d.nodes;
  const polys = new Map(nodes.map((n) => [n.id, shapePoly(n.shape, n.w, n.h, n.x, n.y, 48)] as const));
  const label = (id: string) => d.byId.get(id)?.label ?? id;

  for (const n of nodes) if (!n.placed) out.push({ kind: 'unplaced', ids: [n.id], message: `${n.label} 还没有位置` });
  const W = d.bounds.maxX - d.bounds.minX;
  const H = d.bounds.maxY - d.bounds.minY;
  const areaPerNode = (W * H) / Math.max(1, nodes.length);
  if (W > 30000 || H > 30000 || areaPerNode > 400000) out.push({ kind: 'canvas', ids: [], message: `画布异常大（${Math.round(W)}×${Math.round(H)}），排布没有收拢` });

  // 1. 形状互相压住
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = polys.get(nodes[i].id)!;
      const b = polys.get(nodes[j].id)!;
      if (polyPolyDist(a, b, NODE_GAP) < NODE_GAP) out.push({ kind: 'overlap', ids: [nodes[i].id, nodes[j].id], message: `“${nodes[i].label}”和“${nodes[j].label}”压在一起`, at: { x: (nodes[i].x + nodes[j].x) / 2, y: (nodes[i].y + nodes[j].y) / 2 } });
    }
  }

  // 2. 线和线交叉（共用一个端点的两条线只在那个端点相接，不算）
  const E = d.edges;
  for (let i = 0; i < E.length; i++) {
    for (let j = i + 1; j < E.length; j++) {
      const e = E[i];
      const f = E[j];
      const shared = [e.from, e.to].filter((x) => x === f.from || x === f.to);
      if (!segsIntersect(e.a, e.b, f.a, f.b)) continue;
      if (shared.length) {
        // 同一节点出发的两条线：交点必须就在那个节点的边界上才行（自反关系的并行线也不会相交）
        const p = segIntersection(e.a, e.b, f.a, f.b);
        const node = d.byId.get(shared[0])!;
        // 平行而又相交 = 两条线叠在一起，同样算错
        const nearNode = p ? polyPolyDist(makePoly([p, { x: p.x + 0.01, y: p.y }, { x: p.x, y: p.y + 0.01 }]), polys.get(node.id)!) < 1 : false;
        if (nearNode) continue;
      }
      const p = segIntersection(e.a, e.b, f.a, f.b) ?? e.a;
      out.push({ kind: 'crossing', ids: [e.id, f.id], message: `连线 ${describe(e, label)} 和 ${describe(f, label)} 交叉`, at: p });
    }
  }

  // 3. 线穿过不相干的节点
  for (const e of E) {
    for (const n of nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      if (segPolyDist(e.a, e.b, polys.get(n.id)!, LINE_NODE_GAP) < LINE_NODE_GAP) out.push({ kind: 'line-through-node', ids: [e.id, n.id], message: `连线 ${describe(e, label)} 穿过/贴着“${n.label}”`, at: { x: n.x, y: n.y } });
    }
  }

  // 4. 基数标签压到别的东西
  const cards = E.filter((e) => e.card);
  for (const e of cards) {
    const lp = labelPoly(e.card!);
    for (const n of nodes) {
      if (polyPolyDist(lp, polys.get(n.id)!, 1) < 1) out.push({ kind: 'label-overlap', ids: [e.id, n.id], message: `基数“${e.card!.text}”（${describe(e, label)}）压到“${n.label}”`, at: { x: e.card!.x, y: e.card!.y } });
    }
    for (const f of E) {
      if (f === e) continue;
      if (segPolyDist(f.a, f.b, lp, 0.5) < 0.5) out.push({ kind: 'label-overlap', ids: [e.id, f.id], message: `基数“${e.card!.text}”（${describe(e, label)}）压到连线 ${describe(f, label)}`, at: { x: e.card!.x, y: e.card!.y } });
    }
  }
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (polyPolyDist(labelPoly(cards[i].card!), labelPoly(cards[j].card!), 1) < 1) out.push({ kind: 'label-overlap', ids: [cards[i].id, cards[j].id], message: `两个基数标签压在一起（${describe(cards[i], label)}）`, at: { x: cards[i].card!.x, y: cards[i].card!.y } });
    }
  }
  return out;
}

function describe(e: Diagram['edges'][number], label: (id: string) => string): string {
  return `${label(e.from)}—${label(e.to)}`;
}

/** 证据核对：文件存在，所述行号前后两行内确实有这段文字。 */
export function checkEvidence(model: Model, baseDir: string): Issue[] {
  const out: Issue[] = [];
  const cache = new Map<string, string[] | null>();
  const lines = (file: string) => {
    if (!cache.has(file)) {
      const abs = path.resolve(baseDir, file);
      try {
        cache.set(file, fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n').split('\n'));
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file)!;
  };
  const normWs = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const r of model.relationships) {
    if (r.origin !== 'added') continue;
    if (r.assertedBy === 'user') {
      out.push({ level: 'info', code: 'evidence.user', message: `关系“${r.label}”（${r.id}）由用户指定，不来自源码`, ids: [r.id] });
      continue;
    }
    if (!r.evidence?.length) {
      out.push({ level: 'error', code: 'evidence.missing', message: `关系“${r.label}”（${r.id}）是后加的，但没有给源码证据；请附 file/line/text，或注明 assertedBy: user`, ids: [r.id] });
      continue;
    }
    for (const ev of r.evidence) {
      const ls = lines(ev.file);
      if (!ls) {
        out.push({ level: 'error', code: 'evidence.file', message: `关系“${r.label}”的证据文件 ${ev.file} 不存在`, ids: [r.id] });
        continue;
      }
      const want = normWs(ev.text);
      let hit = -1;
      for (let k = Math.max(1, ev.line - 2); k <= Math.min(ls.length, ev.line + 2); k++) if (normWs(ls[k - 1]).includes(want)) {
        hit = k;
        break;
      }
      if (hit < 0 || !want) out.push({ level: 'error', code: 'evidence.text', message: `关系“${r.label}”的证据对不上：${ev.file} 第 ${ev.line} 行附近没有“${ev.text}”`, ids: [r.id] });
    }
  }
  return out;
}

/** 清单完整性：每一列都落到且只落到一处；模型里的每个属性都能对回清单。 */
export function checkLedger(facts: FactSet, ledger: Ledger, model: Model): Issue[] {
  const out: Issue[] = [];
  const count = new Map<string, number>();
  for (const c of ledger.columns) count.set(lower(c.id), (count.get(lower(c.id)) ?? 0) + 1);
  for (const t of facts.tables) {
    for (const c of t.columns) {
      const id = lower(`${t.name}.${c.name}`);
      const k = count.get(id) ?? 0;
      if (k === 0) out.push({ level: 'error', code: 'ledger.missing', message: `列 ${t.name}.${c.name} 没有画出来，也没有记为排除`, ref: c.ref, ids: [`${t.name}.${c.name}`] });
      else if (k > 1) out.push({ level: 'error', code: 'ledger.duplicate', message: `列 ${t.name}.${c.name} 被记了 ${k} 次`, ref: c.ref, ids: [`${t.name}.${c.name}`] });
    }
  }
  const attrIds = new Set(ledger.columns.filter((c) => c.fate === 'attribute').map((c) => lower(c.target)));
  for (const a of [...model.entities.flatMap((e) => e.attributes), ...model.relationships.flatMap((r) => r.attributes)]) {
    if (a.column && !attrIds.has(lower(a.id))) out.push({ level: 'error', code: 'ledger.orphan', message: `属性 ${a.label}（${a.id}）在清单里找不到来源`, ids: [a.id] });
  }
  return out;
}

export function summarize(facts: FactSet, ledger: Ledger, model: Model, geometry: GeometryProblem[], issues: Issue[]): CheckReport {
  const errors = issues.filter((i) => i.level === 'error').length + geometry.length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  return {
    ok: errors === 0,
    errors,
    warnings,
    geometry,
    issues,
    stats: {
      entities: model.entities.length,
      relationships: model.relationships.length,
      attributes: model.entities.reduce((s, e) => s + e.attributes.length, 0) + model.relationships.reduce((s, r) => s + r.attributes.length, 0),
      columns: facts.tables.reduce((s, t) => s + t.columns.length, 0),
      columnsShown: ledger.columns.filter((c) => c.fate === 'attribute').length,
      columnsAsRelationship: ledger.columns.filter((c) => c.fate === 'relationship').length,
      columnsExcluded: ledger.columns.filter((c) => c.fate === 'excluded').length,
    },
  };
}
