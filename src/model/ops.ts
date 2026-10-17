// 修改操作。人（以后的编辑器）和 agent（MCP）都只通过这一套操作改图：改名、改基数、确认/否定推断、加关系、换形状、改字体、移动……
// 操作写进“决定”和“视图”，模型每次都从源码事实重新推出来，所以源码更新后决定依然有效。

import { SHAPES, type ShapeKind } from '../layout/shapes.js';
import type { Decisions, Evidence, Model } from './types.js';
import type { View } from './view.js';

export type Op =
  | { op: 'rename'; id: string; label: string }
  | { op: 'set_card'; relationship: string; end: number | string; card: string }
  | { op: 'set_table_role'; table: string; role: 'entity' | 'relationship' }
  | { op: 'link_column'; column: string; table: string }
  | { op: 'unlink_column'; column: string }
  | { op: 'exclude'; id: string; reason: string }
  | { op: 'include'; id: string }
  | {
      op: 'add_relationship';
      id?: string;
      label: string;
      ends: { entity: string; card: string }[];
      attributes?: { label: string; key?: boolean }[];
      dashed?: boolean;
      identifying?: boolean;
      evidence?: Evidence[];
      assertedBy?: 'user';
    }
  | { op: 'remove_relationship'; id: string }
  | { op: 'set_flags'; id: string; key?: boolean; partialKey?: boolean; multivalued?: boolean; derived?: boolean; weak?: boolean; identifying?: boolean; dashed?: boolean }
  | { op: 'set_shape'; id: string; shape: ShapeKind | null }
  | { op: 'set_style'; id?: string; kind?: 'entity' | 'relationship' | 'attribute' | 'card'; fontFamily?: string; fontSize?: number; bold?: boolean; cardCase?: 'upper' | 'lower' }
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'place'; id: string; x: number; y: number }
  | { op: 'reset_style'; id?: string; props?: ('fontFamily' | 'fontSize' | 'bold' | 'shape')[] }
  | { op: 'reset_label'; id: string }
  | { op: 'confirm_label'; id: string }
  | { op: 'confirm_relationship'; id: string };

/** 谁做的修改：agent（MCP、命令行）起的名字会进推断项清单等用户确认；用户自己改的不进。 */
export type Actor = 'agent' | 'user';

export interface OpsResult {
  errors: string[];
  applied: number;
  structural: boolean; // 改了模型/尺寸，需要重新排布
}

function slug(s: string): string {
  return s.replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 24) || 'rel';
}

/** 在当前模型上应用一批操作（模型用来检查 id 是否存在）。 */
export function applyOps(d: Decisions, view: View, model: Model, ops: Op[], actor: Actor = 'user'): OpsResult {
  d.agentLabels ??= [];
  const errors: string[] = [];
  let applied = 0;
  let structural = false;
  const nodeIds = new Set<string>([
    ...model.entities.map((e) => e.id),
    ...model.relationships.map((r) => r.id),
    ...model.entities.flatMap((e) => e.attributes.map((a) => a.id)),
    ...model.relationships.flatMap((r) => r.attributes.map((a) => a.id)),
  ]);
  const entityIds = new Set(model.entities.map((e) => e.id));
  const tables = new Set(model.entities.map((e) => e.table).concat(model.relationships.filter((r) => r.table).map((r) => r.table!)));
  const relById = new Map(model.relationships.map((r) => [r.id, r] as const));

  ops.forEach((op, i) => {
    const fail = (m: string) => errors.push(`第 ${i + 1} 个操作（${op.op}）：${m}`);
    switch (op.op) {
      case 'rename':
        if (!nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
        if (!op.label.trim()) return fail('名字不能为空');
        d.labels[op.id] = op.label.trim();
        d.agentLabels = d.agentLabels.filter((x) => x !== op.id);
        if (actor === 'agent') d.agentLabels.push(op.id);
        structural = true;
        break;
      case 'reset_label':
        if (!nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
        delete d.labels[op.id];
        d.agentLabels = d.agentLabels.filter((x) => x !== op.id);
        structural = true;
        break;
      case 'confirm_label':
        if (actor === 'agent') return fail('推断项只能由用户在编辑器里确认');
        d.agentLabels = d.agentLabels.filter((x) => x !== op.id);
        break;
      case 'confirm_relationship': {
        if (actor === 'agent') return fail('推断项只能由用户在编辑器里确认');
        const x = d.extraRelationships.find((e) => e.id === op.id);
        if (!x) return fail(`找不到后加的关系 ${op.id}`);
        x.confirmed = true;
        break;
      }
      case 'set_card': {
        const r = relById.get(op.relationship);
        if (!r) return fail(`找不到关系 ${op.relationship}`);
        const idx = typeof op.end === 'number' ? op.end : r.ends.findIndex((e) => e.entity === op.end);
        if (idx < 0 || idx >= r.ends.length) return fail(`关系 ${r.label} 没有这一端：${op.end}`);
        if (r.origin === 'added') {
          const x = d.extraRelationships.find((e) => e.id === r.id)!;
          x.ends[idx].card = op.card;
        } else d.cards[`${r.id}#${idx}`] = op.card;
        structural = true;
        break;
      }
      case 'set_table_role':
        if (!tables.has(op.table) && !Object.keys(d.tableRoles).includes(op.table)) return fail(`找不到表 ${op.table}`);
        d.tableRoles[op.table] = op.role;
        structural = true;
        break;
      case 'link_column':
        if (!/\./.test(op.column)) return fail('column 要写成 表名.列名');
        d.links[op.column] = { table: op.table };
        d.unlinks = d.unlinks.filter((x) => x !== op.column);
        structural = true;
        break;
      case 'unlink_column':
        if (!/\./.test(op.column)) return fail('column 要写成 表名.列名');
        delete d.links[op.column];
        if (!d.unlinks.includes(op.column)) d.unlinks.push(op.column);
        structural = true;
        break;
      case 'exclude':
        if (!op.reason?.trim()) return fail('排除必须写原因');
        d.exclusions[op.id] = op.reason.trim();
        structural = true;
        break;
      case 'include':
        delete d.exclusions[op.id];
        structural = true;
        break;
      case 'add_relationship': {
        if (op.ends.length < 2) return fail('关系至少连两端（自反关系把同一个实体写两次）');
        const bad = op.ends.filter((e) => !entityIds.has(e.entity));
        if (bad.length) return fail(`不存在的实体：${bad.map((b) => b.entity).join('、')}`);
        if (!op.evidence?.length && op.assertedBy !== 'user') return fail('必须给出源码证据 evidence（file、line、text），或在用户明确说过时写 assertedBy: "user"');
        let id = op.id ? (op.id.startsWith('add:') ? op.id : `add:${op.id}`) : `add:${slug(op.label)}_${op.ends.map((e) => e.entity).join('_')}`;
        while (relById.has(id) || d.extraRelationships.some((x) => x.id === id)) id += '_2';
        d.extraRelationships.push({ id, label: op.label, ends: op.ends.map((e) => ({ ...e })), attributes: op.attributes, dashed: op.dashed, identifying: op.identifying, evidence: op.evidence, assertedBy: op.assertedBy });
        structural = true;
        break;
      }
      case 'remove_relationship': {
        const k = d.extraRelationships.findIndex((x) => x.id === op.id);
        if (k < 0) {
          const r = relById.get(op.id);
          if (r?.origin === 'join-table') return fail(`${op.id} 来自关联表 ${r.table}：要么 exclude 这张表并写原因，要么 set_table_role 改成实体`);
          if (r) return fail(`${op.id} 来自外键列：要么 unlink_column 把列当普通属性，要么 exclude 这一列并写原因`);
          return fail(`找不到关系 ${op.id}`);
        }
        d.extraRelationships.splice(k, 1);
        structural = true;
        break;
      }
      case 'set_flags': {
        if (!nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
        const { op: _o, id, ...flags } = op;
        void _o;
        d.flags[id] = { ...d.flags[id], ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)) };
        structural = true;
        break;
      }
      case 'set_shape':
        if (!nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
        if (op.shape !== null && !SHAPES.includes(op.shape)) return fail(`不认识的形状 ${op.shape}，可选：${SHAPES.join('、')}`);
        view.nodes[op.id] = { ...view.nodes[op.id], shape: op.shape ?? undefined };
        structural = true;
        break;
      case 'set_style': {
        if (op.id) {
          if (!nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
          const nv = { ...view.nodes[op.id] };
          if (op.fontFamily !== undefined) nv.fontFamily = op.fontFamily;
          if (op.fontSize !== undefined) nv.fontSize = op.fontSize;
          if (op.bold !== undefined) nv.bold = op.bold;
          view.nodes[op.id] = nv;
        } else {
          if (op.fontFamily) view.style.fontFamily = op.fontFamily;
          if (op.cardCase) view.style.cardCase = op.cardCase;
          const kinds = op.kind ? [op.kind] : (['entity', 'relationship', 'attribute', 'card'] as const);
          for (const k of kinds) {
            if (op.fontSize !== undefined) view.style[k].size = op.fontSize;
            if (op.bold !== undefined) view.style[k].bold = op.bold;
          }
        }
        structural = true;
        break;
      }
      case 'move': {
        if (!nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
        const cur = view.nodes[op.id] ?? {};
        const dx = op.x - (cur.x ?? op.x);
        const dy = op.y - (cur.y ?? op.y);
        view.nodes[op.id] = { ...cur, x: op.x, y: op.y, pinned: true };
        // 拖实体/关系时，它的属性整体跟着走
        const owner = [...model.entities, ...model.relationships].find((x) => x.id === op.id);
        for (const a of owner?.attributes ?? []) {
          const av = view.nodes[a.id];
          if (av?.x !== undefined && av.y !== undefined && !av.pinned) view.nodes[a.id] = { ...av, x: av.x + dx, y: av.y + dy };
        }
        break;
      }
      case 'place': {
        // 绝对位置（draw.io 读回、编辑器里逐个摆放）：不带动属性
        if (!nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
        view.nodes[op.id] = { ...view.nodes[op.id], x: op.x, y: op.y, pinned: true };
        break;
      }
      case 'reset_style': {
        const props = op.props ?? ['fontFamily', 'fontSize', 'bold', 'shape'];
        const targets = op.id ? [op.id] : Object.keys(view.nodes);
        if (op.id && !nodeIds.has(op.id)) return fail(`找不到 ${op.id}`);
        for (const id of targets) {
          const nv = { ...view.nodes[id] };
          for (const k of props) delete nv[k];
          view.nodes[id] = nv;
        }
        structural = true;
        break;
      }
      default:
        return fail('不认识的操作');
    }
    applied++;
  });
  return { errors, applied, structural };
}
