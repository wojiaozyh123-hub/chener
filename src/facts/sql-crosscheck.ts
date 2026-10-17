// 第二条独立的解析路径：用 node-sql-parser 再解析每一条 CREATE TABLE，和自己的解析结果逐项对比。
// 两边对不上就报错；第二个解析器读不懂的语句如实记为“未交叉核对”，不算通过也不算失败。

import { createRequire } from 'node:module';
import type { Issue, TableFact } from './types.js';
import { lower } from './types.js';
import type { CreateSegment } from './sql.js';

const require = createRequire(import.meta.url);
// node-sql-parser 是 CommonJS
const { Parser } = require('node-sql-parser') as { Parser: new () => { astify(sql: string, opt: { database: string }): unknown } };

const DIALECTS = ['MySQL', 'MariaDB', 'PostgresQL', 'SQLite', 'TransactSQL'];

interface Seen {
  table: string;
  columns: string[];
  pk: string[];
  fks: { col: string; ref: string }[];
}

function nameOf(x: unknown): string | undefined {
  if (x == null) return undefined;
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.value === 'string') return o.value;
    if (o.expr) return nameOf(o.expr);
    if (o.column) return nameOf(o.column);
  }
  return undefined;
}

function tableNameOf(x: unknown): string | undefined {
  const arr = Array.isArray(x) ? x : [x];
  const t = arr[0] as Record<string, unknown> | undefined;
  return t ? nameOf(t.table) : undefined;
}

function strip(s: string): string {
  return s.replace(/^[`"[]|[`"\]]$/g, '');
}

function readAst(ast: unknown): Seen | null {
  const list = Array.isArray(ast) ? ast : [ast];
  const st = list.find((s) => s && (s as Record<string, unknown>).type === 'create') as Record<string, unknown> | undefined;
  if (!st) return null;
  const table = tableNameOf(st.table);
  if (!table) return null;
  const seen: Seen = { table: strip(table), columns: [], pk: [], fks: [] };
  for (const d of (st.create_definitions as Record<string, unknown>[] | undefined) ?? []) {
    if (d.resource === 'column') {
      const c = nameOf(d.column);
      if (!c) continue;
      const name = strip(c);
      seen.columns.push(name);
      const pkText = String((d as Record<string, unknown>).primary_key ?? '');
      if (/primary/i.test(pkText)) seen.pk.push(name);
      const rd = d.reference_definition as Record<string, unknown> | undefined;
      const rt = rd ? tableNameOf(rd.table) : undefined;
      if (rt) seen.fks.push({ col: name, ref: strip(rt) });
    } else if (d.resource === 'constraint') {
      const kind = String(d.constraint_type ?? '').toLowerCase();
      const cols = ((d.definition as unknown[]) ?? []).map(nameOf).filter((x): x is string => !!x).map(strip);
      if (kind.includes('primary')) seen.pk.push(...cols);
      if (kind.includes('foreign')) {
        const rd = d.reference_definition as Record<string, unknown> | undefined;
        const rt = rd ? tableNameOf(rd.table) : undefined;
        if (rt) for (const c of cols) seen.fks.push({ col: c, ref: strip(rt) });
      }
    }
  }
  return seen;
}

function diff(a: string[], b: string[]): string[] {
  const s = new Set(b.map(lower));
  return a.filter((x) => !s.has(lower(x)));
}

/** 对每条 CREATE TABLE 做交叉核对。tables 是自己解析出来、尚未叠加 ALTER 的结果之前的那份，所以只比 CREATE 语句本身。 */
export function crossCheck(segments: CreateSegment[], ownCreateOnly: Map<string, TableFact>, file: string): { issues: Issue[]; checked: number; unchecked: string[] } {
  const issues: Issue[] = [];
  const unchecked: string[] = [];
  let checked = 0;
  const parser = new Parser();
  for (const seg of segments) {
    let seen: Seen | null = null;
    for (const db of DIALECTS) {
      try {
        seen = readAst(parser.astify(seg.text, { database: db }));
        if (seen) break;
      } catch {
        // 换下一个方言
      }
    }
    const own = ownCreateOnly.get(lower(seg.table));
    if (!seen || !own) {
      unchecked.push(seg.table);
      continue;
    }
    checked++;
    const ref = { file, line: seg.line };
    const problems: string[] = [];
    if (lower(seen.table) !== lower(own.name)) problems.push(`表名：${own.name} / ${seen.table}`);
    const ownCols = own.columns.map((c) => c.name);
    const onlyOwn = diff(ownCols, seen.columns);
    const onlySeen = diff(seen.columns, ownCols);
    if (onlyOwn.length) problems.push(`只有主解析器读到的列：${onlyOwn.join('、')}`);
    if (onlySeen.length) problems.push(`只有核对解析器读到的列：${onlySeen.join('、')}`);
    const ownPk = own.primaryKey;
    if (diff(ownPk, seen.pk).length || diff(seen.pk, ownPk).length) problems.push(`主键不同：${ownPk.join(',') || '无'} / ${seen.pk.join(',') || '无'}`);
    const ownFk = own.foreignKeys.flatMap((f) => f.columns.map((c) => `${lower(c)}→${lower(f.refTable)}`));
    const seenFk = seen.fks.map((f) => `${lower(f.col)}→${lower(f.ref)}`);
    if (diff(ownFk, seenFk).length || diff(seenFk, ownFk).length) problems.push(`外键不同：${ownFk.join(',') || '无'} / ${seenFk.join(',') || '无'}`);
    if (problems.length) {
      issues.push({ level: 'error', code: 'sql.crosscheck.mismatch', message: `表 ${own.name}（第 ${seg.line} 行）两个解析器结果不一致：${problems.join('；')}`, ref, ids: [own.name] });
    }
  }
  if (unchecked.length) {
    issues.push({ level: 'info', code: 'sql.crosscheck.skipped', message: `${file}：${unchecked.length} 张表核对解析器读不懂，只经过主解析器：${unchecked.join('、')}` });
  }
  return { issues, checked, unchecked };
}
