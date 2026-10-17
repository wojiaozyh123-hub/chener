// 推断项清单：程序或 agent 推断出来、还没经用户确认的东西。每一条给出“留”和“删”各自对应的修改操作。
// 用户自己改过的不算推断，不进清单；“留”之后变成用户的决定，从清单里消失。

import type { FactSet } from '../facts/types.js';
import { lower } from '../facts/types.js';
import { convert } from './convert.js';
import type { Op } from './ops.js';
import type { Decisions, Model, Pending } from './types.js';

export type InferredKind = 'fk' | 'role' | 'added' | 'agent-label' | 'derived-label';

export interface InferredItem {
  key: string;
  kind: InferredKind;
  what: string; // 是什么
  basis: string; // 凭什么这么推
  ids: string[]; // 画面上对应的节点（悬停时高亮）
  keep: Op[];
  drop: Op[];
}

export function inferredItems(facts: FactSet, d: Decisions, model: Model, pending: Pending[]): InferredItem[] {
  const items: InferredItem[] = [];
  const entityById = new Map(model.entities.map((e) => [lower(e.id), e] as const));
  const relById = new Map(model.relationships.map((r) => [r.id, r] as const));
  // 实体用图上的名字；关联表在图上是菱形，直接写表名，免得“关联.playlist_id”这种看不出是哪张表
  const tableLabel = (t: string) => entityById.get(lower(t))?.label ?? t;

  // 1. 按列名推断的外键
  for (const p of pending.filter((x) => x.kind === 'fk-inferred')) {
    const [table, col] = [p.id.slice(0, p.id.indexOf('.')), p.id.slice(p.id.indexOf('.') + 1)];
    const target = p.suggestions?.[0] ?? '';
    const rel = relById.get(`fk:${p.id}`) ?? relById.get(`rel:${table}`);
    items.push({
      key: `fk:${p.id}`,
      kind: 'fk',
      what: `外键 ${tableLabel(table)}.${col} → ${tableLabel(target)}`,
      basis: '', // 依据就是列名本身，行里已经写着
      ids: [rel?.id, entityById.get(lower(table))?.id, entityById.get(lower(target))?.id].filter((x): x is string => !!x),
      keep: [{ op: 'link_column', column: p.id, table: target }],
      drop: [{ op: 'unlink_column', column: p.id }],
    });
  }

  // 2. 按规则判成 M:N 关系的表
  for (const p of pending.filter((x) => x.kind === 'role-heuristic')) {
    const rel = relById.get(`rel:${p.id}`);
    if (!rel) continue; // 判成实体的是默认情况，不算推断
    // 只留判定理由的关键一句：主键就是外键 / 表名像关联表 / 自身列少
    const reason = (/：(.+?)；/.exec(p.message)?.[1] ?? '').replace(/^连了 \d+ 张表，/, '').replace(/，没有别的表引用它 → M:N 关系$/, '').replace(/、没有名称类的列$/, '');
    items.push({
      key: `role:${p.id}`,
      kind: 'role',
      what: `表 ${p.id} 画成关系“${rel.label}”`,
      basis: reason,
      ids: [rel.id, ...rel.ends.map((e) => e.entity)],
      keep: [{ op: 'set_table_role', table: p.id, role: 'relationship' }],
      drop: [{ op: 'set_table_role', table: p.id, role: 'entity' }],
    });
  }

  // 3. 后加的关系
  for (const x of d.extraRelationships) {
    if (x.confirmed || !relById.has(x.id)) continue;
    const r = relById.get(x.id)!;
    const ends = r.ends.map((e) => entityById.get(lower(e.entity))?.label ?? e.entity);
    const ev = x.evidence?.[0];
    items.push({
      key: `added:${x.id}`,
      kind: 'added',
      what: `关系 ${ends[0]}—${r.label}—${ends.slice(1).join('、')}`,
      basis: ev ? `${ev.file} 第 ${ev.line} 行“${ev.text}”` : x.assertedBy === 'user' ? '你说过有这条关系' : '没有依据',
      ids: [r.id, ...r.ends.map((e) => e.entity)],
      keep: [{ op: 'confirm_relationship', id: x.id }],
      drop: [{ op: 'remove_relationship', id: x.id }],
    });
  }

  // 4. agent 起的名字（和不算它时的原名对比）
  const agentIds = (d.agentLabels ?? []).filter((id) => id in d.labels);
  if (agentIds.length) {
    const labels = { ...d.labels };
    for (const id of agentIds) delete labels[id];
    const base = convert(facts, { ...d, labels }).model;
    const orig = new Map<string, string>();
    for (const e of base.entities) {
      orig.set(e.id, e.label);
      for (const a of e.attributes) orig.set(a.id, a.label);
    }
    for (const r of base.relationships) {
      orig.set(r.id, r.label);
      for (const a of r.attributes) orig.set(a.id, a.label);
    }
    for (const id of agentIds) {
      items.push({
        key: `label:${id}`,
        kind: 'agent-label',
        what: `${orig.get(id) ?? id} 改名为 ${d.labels[id]}`,
        basis: 'agent 起的名',
        ids: [id],
        keep: [{ op: 'confirm_label', id }],
        drop: [{ op: 'reset_label', id }],
      });
    }
  }

  // 5. 程序从注释推出来的名字
  for (const e of model.entities) {
    if (e.labelFrom !== 'derived') continue;
    items.push({
      key: `derived:${e.id}`,
      kind: 'derived-label',
      what: `表 ${e.table} 叫“${e.label}”`,
      basis: '表没有注释，取自引用它的外键列注释',
      ids: [e.id],
      keep: [{ op: 'rename', id: e.id, label: e.label }],
      drop: [{ op: 'rename', id: e.id, label: e.table }],
    });
  }
  for (const r of model.relationships) {
    if (r.labelFrom !== 'derived') continue;
    const ends = r.ends.map((x) => entityById.get(lower(x.entity))?.label ?? x.entity);
    const fromJoin = r.origin === 'join-table';
    items.push({
      key: `derived:${r.id}`,
      kind: 'derived-label',
      what: `${ends[0]}—${ends.slice(1).join('、')} 的关系叫“${r.label}”`,
      basis: fromJoin ? `取自表 ${r.table} 的注释` : '取自外键列的注释',
      ids: [r.id],
      keep: [{ op: 'rename', id: r.id, label: r.label }],
      drop: [{ op: 'rename', id: r.id, label: fromJoin ? r.table! : '拥有' }],
    });
  }
  return items;
}
