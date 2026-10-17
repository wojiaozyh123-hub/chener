// Chen 模型：实体、属性、关系、基数，以及“每一列落到哪里”的清单。
// 模型 = convert(源码事实, 决定)。决定（改名、改基数、确认推断、加关系……）单独存，重新导入源码时照样生效。

import type { Issue, SourceRef } from '../facts/types.js';

export type LabelFrom = 'comment' | 'docstring' | 'line-comment' | 'name' | 'derived' | 'default' | 'decision';

export interface Attribute {
  id: string; // 表名.列名；手工加的属性是 关系id.序号
  label: string;
  labelFrom: LabelFrom;
  column?: string;
  key: boolean; // 主键：实线下划线
  partialKey: boolean; // 弱实体的部分键：虚线下划线
  multivalued: boolean; // 双椭圆
  derived: boolean; // 虚线椭圆
  ref?: SourceRef;
}

export interface Entity {
  id: string; // 表名
  label: string;
  labelFrom: LabelFrom;
  table: string;
  weak: boolean; // 双矩形
  attributes: Attribute[];
  ref?: SourceRef;
}

export interface RelEnd {
  entity: string;
  card: string; // '1' 'N' 'M' 或自定义文本
  column?: string; // 来自哪个外键列
}

export interface Evidence {
  file: string;
  line: number;
  text: string;
}

export type RelOrigin = 'fk' | 'fk-inferred' | 'join-table' | 'added';

export interface Relationship {
  id: string; // fk:表.列 / rel:关联表 / add:xxx
  label: string;
  labelFrom: LabelFrom;
  ends: RelEnd[];
  attributes: Attribute[];
  identifying: boolean; // 双菱形
  dashed: boolean; // 虚线：逻辑关联
  origin: RelOrigin;
  table?: string; // join-table 来源
  evidence?: Evidence[];
  assertedBy?: 'user';
  ref?: SourceRef;
}

export interface Model {
  entities: Entity[];
  relationships: Relationship[];
}

export type ColumnFate = 'attribute' | 'relationship' | 'excluded';

export interface LedgerColumn {
  id: string; // 表.列
  table: string;
  column: string;
  fate: ColumnFate;
  target: string; // 属性 id / 关系 id / 排除原因
  note?: string;
  ref?: SourceRef;
}

export interface LedgerTable {
  table: string;
  role: 'entity' | 'relationship' | 'excluded';
  target: string;
  reason: string;
  ref?: SourceRef;
}

export interface Ledger {
  tables: LedgerTable[];
  columns: LedgerColumn[];
}

export type PendingKind = 'label-untranslated' | 'label-default' | 'fk-inferred' | 'fk-ambiguous' | 'role-heuristic' | 'no-key';

export interface Pending {
  kind: PendingKind;
  id: string;
  message: string;
  suggestions?: string[];
}

export interface ExtraRelationship {
  id: string;
  label: string;
  ends: RelEnd[];
  attributes?: { label: string; key?: boolean }[];
  dashed?: boolean;
  identifying?: boolean;
  evidence?: Evidence[];
  assertedBy?: 'user';
}

export interface Decisions {
  labels: Record<string, string>;
  tableRoles: Record<string, 'entity' | 'relationship'>;
  links: Record<string, { table: string }>; // 表.列 → 目标表（确认推断或手工指定外键）
  unlinks: string[]; // 表.列：不当外键，按普通属性
  exclusions: Record<string, string>; // 表 或 表.列 → 排除原因
  cards: Record<string, string>; // 关系id#端序号 → 基数文本
  flags: Record<string, Partial<{ key: boolean; partialKey: boolean; multivalued: boolean; derived: boolean; weak: boolean; identifying: boolean; dashed: boolean }>>;
  extraRelationships: ExtraRelationship[];
}

export function emptyDecisions(): Decisions {
  return { labels: {}, tableRoles: {}, links: {}, unlinks: [], exclusions: {}, cards: {}, flags: {}, extraRelationships: [] };
}

export interface ConvertResult {
  model: Model;
  ledger: Ledger;
  pending: Pending[];
  issues: Issue[];
}
