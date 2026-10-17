// 建表语句解析：自己的容错解析器（带每一列的行号）。另有 sql-crosscheck.ts 用第二个解析器逐表核对。

import type { ColumnFact, Issue, TableFact } from './types.js';
import { lower } from './types.js';
import { matchParen, readQualifiedName, splitStatements, splitTopLevel, tokenize, type Comment, type Token } from './sql-lexer.js';

export interface CreateSegment {
  table: string;
  text: string; // 这条 CREATE TABLE 的原文（交叉核对用）
  line: number;
}

export interface SqlParseResult {
  tables: TableFact[];
  issues: Issue[];
  segments: CreateSegment[];
  /** 每张表只看 CREATE 语句本身时的样子（叠加 ALTER、COMMENT ON 之前），给交叉核对用 */
  createOnly: Map<string, TableFact>;
  /** ALTER / COMMENT ON / 唯一索引：等所有文件的 CREATE TABLE 都读完再统一叠加（迁移脚本会跨文件改表） */
  pending: PendingChanges;
}

export interface PendingChanges {
  alters: { tokens: Token[]; comments: Comment[]; line: number; file: string }[];
  comments: (PendingComment & { file: string })[];
  uniques: { table: string; cols: string[]; line: number; file: string }[];
}

const COLUMN_OPTION_WORDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'COMMENT', 'REFERENCES', 'CHECK',
  'CONSTRAINT', 'COLLATE', 'CHARACTER', 'CHARSET', 'GENERATED', 'AS', 'ON', 'IDENTITY', 'KEY', 'VIRTUAL', 'STORED',
  'INVISIBLE', 'VISIBLE', 'COLUMN_FORMAT', 'STORAGE', 'SRID', 'ENCODE', 'ROWGUIDCOL', 'SPARSE', 'FILESTREAM', 'MASKED',
  'ENABLE', 'DISABLE', 'CLUSTERED', 'NONCLUSTERED',
]);

const CONSTRAINT_START = new Set(['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'FOREIGN', 'FULLTEXT', 'SPATIAL', 'CHECK', 'EXCLUDE', 'PERIOD', 'LIKE']);

interface PendingComment {
  table: string;
  column?: string;
  text: string;
  line: number;
}

/** 解析一个 SQL 文件。file 用于出处。 */
export function parseSqlText(src: string, file: string): SqlParseResult {
  const tables: TableFact[] = [];
  const issues: Issue[] = [];
  const segments: CreateSegment[] = [];
  const createOnly = new Map<string, TableFact>();
  const pending: PendingChanges = { alters: [], comments: [], uniques: [] };

  for (const st of splitStatements(src)) {
    const { tokens, comments: lineComments } = tokenize(st.text, st.startLine);
    let toks = tokens;
    while (toks.length && toks[0].upper === 'GO' && toks[0].kind === 'word') toks = toks.slice(1);
    if (!toks.length) continue;

    // 一条语句里可能粘着好几个 CREATE TABLE（漏了分号或 GO）：按 CREATE ... TABLE 的位置拆开，各自解析
    const starts = createTableStarts(toks);
    if (starts.length) {
      for (let k = 0; k < starts.length; k++) {
        const seg = toks.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : toks.length);
        const segText = st.text.slice(seg[0].offset, seg[seg.length - 1].end);
        const res = parseCreateTable(seg, lineComments, file);
        if ('error' in res) {
          issues.push({ level: 'error', code: 'sql.create.unparsed', message: `第 ${seg[0].line} 行的 CREATE TABLE 没读懂：${res.error}`, ref: { file, line: seg[0].line } });
        } else {
          const key = lower(res.table.name);
          const dup = tables.findIndex((t) => lower(t.name) === key);
          if (dup >= 0) {
            issues.push({ level: 'warning', code: 'sql.create.duplicate', message: `表 ${res.table.name} 定义了两次（第 ${tables[dup].ref.line} 行和第 ${res.table.ref.line} 行），按后一次算`, ref: res.table.ref });
            tables.splice(dup, 1);
            const si = segments.findIndex((x) => lower(x.table) === key);
            if (si >= 0) segments.splice(si, 1);
          }
          tables.push(res.table);
          segments.push({ table: res.table.name, text: segText, line: seg[0].line });
          const snap: TableFact = structuredClone(res.table);
          finalizeTable(snap);
          createOnly.set(key, snap);
          issues.push(...res.issues);
        }
      }
      continue;
    }

    const u0 = toks[0].upper;
    const u1 = toks[1]?.upper;
    if (u0 === 'ALTER' && u1 === 'TABLE') {
      pending.alters.push({ tokens: toks, comments: lineComments, line: toks[0].line, file });
    } else if (u0 === 'COMMENT' && u1 === 'ON') {
      const c = parseCommentOn(toks);
      if (c) pending.comments.push({ ...c, file });
    } else if (u0 === 'CREATE' && (u1 === 'UNIQUE' || (u1 && toks[2]?.upper === 'UNIQUE'))) {
      const u = parseCreateUniqueIndex(toks);
      if (u) pending.uniques.push({ ...u, file });
    } else if ((u0 === 'EXEC' || u0 === 'EXECUTE') && toks.some((t) => /sp_addextendedproperty$/i.test(t.value))) {
      const c = parseExtendedProperty(toks);
      if (c) pending.comments.push({ ...c, file });
    }
  }

  return { tables, issues, segments, createOnly, pending };
}

/** 把所有文件的 ALTER / 注释 / 唯一索引叠加到表上（按文件顺序），然后汇总主键和唯一。 */
export function applyPending(tables: TableFact[], pending: PendingChanges[], issues: Issue[]): void {
  const byName = new Map(tables.map((t) => [lower(t.name), t] as const));
  const finder = (file: string) => (name: string, line: number, what: string) => {
    const t = byName.get(lower(name));
    if (!t) issues.push({ level: 'warning', code: 'sql.unknown-table', message: `${file} 第 ${line} 行的${what}指向不存在的表 ${name}`, ref: { file, line } });
    return t;
  };
  for (const p of pending) {
    for (const a of p.alters) applyAlter(a.tokens, a.comments, a.file, finder(a.file), issues);
    for (const c of p.comments) {
      const t = finder(c.file)(c.table, c.line, '注释');
      if (!t) continue;
      if (c.column) {
        const col = t.columns.find((x) => lower(x.name) === lower(c.column!));
        if (col) {
          col.comment = c.text;
          col.commentFrom = 'comment';
        } else issues.push({ level: 'warning', code: 'sql.unknown-column', message: `${c.file} 第 ${c.line} 行的注释指向不存在的列 ${c.table}.${c.column}`, ref: { file: c.file, line: c.line } });
      } else {
        t.comment = c.text;
        t.commentFrom = 'comment';
      }
    }
    for (const u of p.uniques) {
      const t = finder(u.file)(u.table, u.line, '唯一索引');
      if (t) t.uniques.push(u.cols);
    }
  }
  for (const t of tables) finalizeTable(t);
}

function createTableStarts(toks: Token[]): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'punct' && t.text === '(') depth++;
    if (t.kind === 'punct' && t.text === ')') depth--;
    if (depth !== 0 || t.kind !== 'word' || t.upper !== 'CREATE') continue;
    for (let j = i + 1; j < Math.min(toks.length, i + 6); j++) {
      const u = toks[j].upper;
      if (u === 'TABLE') {
        out.push(i);
        break;
      }
      if (!['OR', 'REPLACE', 'GLOBAL', 'LOCAL', 'TEMPORARY', 'TEMP', 'UNLOGGED', 'VIRTUAL', 'EXTERNAL', 'TRANSIENT'].includes(u)) break;
    }
  }
  return out;
}

function parseCreateTable(toks: Token[], lineComments: Comment[], file: string): { table: TableFact; issues: Issue[] } | { error: string } {
  const issues: Issue[] = [];
  let i = 0;
  while (i < toks.length && toks[i].upper !== 'TABLE') i++;
  i++;
  if (toks[i]?.upper === 'IF' && toks[i + 1]?.upper === 'NOT' && toks[i + 2]?.upper === 'EXISTS') i += 3;
  const qn = readQualifiedName(toks, i);
  if (!qn) return { error: '找不到表名' };
  const name = qn.parts[qn.parts.length - 1];
  i = qn.next;
  if (toks[i]?.text !== '(') {
    const w = toks[i]?.upper;
    if (w === 'LIKE' || w === 'AS') return { error: `表 ${name} 用 CREATE TABLE ... ${w} 定义，读不出列，请改用完整的建表语句` };
    return { error: `表 ${name} 后面没有列定义` };
  }
  const close = matchParen(toks, i);
  if (close < 0) return { error: `表 ${name} 的括号没有闭合` };

  const table: TableFact = {
    name,
    columns: [],
    primaryKey: [],
    uniques: [],
    foreignKeys: [],
    ref: { file, line: toks[0].line },
    origin: 'sql',
  };

  for (const def of splitTopLevel(toks.slice(i + 1, close))) {
    if (!def.length) continue;
    const first = def[0];
    if (first.kind === 'word' && first.upper === 'CONSTRAINT') {
      applyConstraint(table, def.slice(2), def[1]?.value, file, issues);
    } else if (isConstraintDef(def)) {
      applyConstraint(table, def, undefined, file, issues);
    } else {
      const col = parseColumn(def, lineComments, file, table);
      if (col) table.columns.push(col);
      else issues.push({ level: 'error', code: 'sql.column.unparsed', message: `表 ${name} 第 ${first.line} 行的定义没读懂：${def.map((t) => t.text).join(' ').slice(0, 80)}`, ref: { file, line: first.line } });
    }
  }

  // 表选项里的 COMMENT
  for (let j = close + 1; j < toks.length; j++) {
    if (toks[j].upper === 'COMMENT') {
      let k = j + 1;
      if (toks[k]?.text === '=') k++;
      if (toks[k]?.kind === 'string' || toks[k]?.kind === 'qident') {
        table.comment = toks[k].value;
        table.commentFrom = 'comment';
      }
    }
  }
  return { table, issues };
}

/** KEY / INDEX / UNIQUE ... 开头的是约束；但 SQLite 允许不加引号的列名 key、index，此时后面紧跟类型名。 */
function isConstraintDef(def: Token[]): boolean {
  const first = def[0];
  return first.kind === 'word' && CONSTRAINT_START.has(first.upper) && !(def[1] && def[1].kind === 'word' && isTypeWord(def[1]));
}

function isTypeWord(t: Token): boolean {
  return /^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|VARCHAR|CHAR|TEXT|DATE|DATETIME|TIMESTAMP|DECIMAL|NUMERIC|FLOAT|DOUBLE|BOOLEAN|BOOL|BLOB|JSON|UUID|SERIAL|BIGSERIAL|NVARCHAR|NCHAR|NUMBER|VARCHAR2|CLOB|REAL|BIT|LONGTEXT|MEDIUMTEXT|TINYTEXT|TIME|YEAR|ENUM|SET)$/i.test(t.value);
}

function readColumnList(toks: Token[], i: number): { cols: string[]; next: number } | null {
  if (toks[i]?.text !== '(') return null;
  const close = matchParen(toks, i);
  if (close < 0) return null;
  const cols: string[] = [];
  for (const item of splitTopLevel(toks.slice(i + 1, close))) {
    const t = item.find((x) => x.kind === 'word' || x.kind === 'qident');
    if (t) cols.push(t.value);
  }
  return { cols, next: close + 1 };
}

function skipToParen(toks: Token[], i: number): number {
  while (i < toks.length && toks[i].text !== '(') i++;
  return i;
}

function readReferences(toks: Token[], i: number): { table: string; cols: string[]; next: number } | null {
  // toks[i] 是 REFERENCES
  const qn = readQualifiedName(toks, i + 1);
  if (!qn) return null;
  const cl = readColumnList(toks, qn.next);
  return { table: qn.parts[qn.parts.length - 1], cols: cl?.cols ?? [], next: cl?.next ?? qn.next };
}

function applyConstraint(table: TableFact, def: Token[], name: string | undefined, file: string, issues: Issue[]): void {
  const u = def[0]?.upper;
  const line = def[0]?.line ?? table.ref.line;
  if (u === 'PRIMARY') {
    const cl = readColumnList(def, skipToParen(def, 1));
    if (cl) table.primaryKey.push(...cl.cols.filter((c) => !table.primaryKey.includes(c)));
  } else if (u === 'UNIQUE') {
    const cl = readColumnList(def, skipToParen(def, 1));
    if (cl) table.uniques.push(cl.cols);
  } else if (u === 'FOREIGN') {
    const p = skipToParen(def, 1);
    const cl = readColumnList(def, p);
    const r = def.findIndex((t) => t.upper === 'REFERENCES');
    const ref = r >= 0 ? readReferences(def, r) : null;
    if (cl && ref) table.foreignKeys.push({ columns: cl.cols, refTable: ref.table, refColumns: ref.cols, name, ref: { file, line } });
    else issues.push({ level: 'error', code: 'sql.fk.unparsed', message: `表 ${table.name} 第 ${line} 行的外键没读懂`, ref: { file, line } });
  }
  // KEY / INDEX / FULLTEXT / SPATIAL / CHECK / EXCLUDE：普通索引和检查约束，不影响 ER 结构
}

function parseColumn(def: Token[], lineComments: Comment[], file: string, table: TableFact): ColumnFact | null {
  const nameTok = def[0];
  if (nameTok.kind !== 'word' && nameTok.kind !== 'qident') return null;
  let i = 1;
  const typeToks: Token[] = [];
  let depth = 0;
  while (i < def.length) {
    const t = def[i];
    if (t.text === '(') depth++;
    if (t.text === ')') depth--;
    if (depth === 0 && typeToks.length > 0 && t.kind === 'word' && COLUMN_OPTION_WORDS.has(t.upper)) break;
    typeToks.push(t);
    i++;
  }
  const col: ColumnFact = {
    name: nameTok.value,
    type: typeToks.map((t) => (t.kind === 'qident' ? t.value : t.text)).join(' ').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').replace(/\s*,\s*/g, ','),
    pk: false,
    unique: false,
    notNull: false,
    ref: { file, line: nameTok.line },
  };
  for (; i < def.length; i++) {
    const t = def[i];
    if (t.kind !== 'word') continue;
    if (t.upper === 'PRIMARY' && def[i + 1]?.upper === 'KEY') col.pk = true;
    else if (t.upper === 'UNIQUE') col.unique = true;
    else if (t.upper === 'NOT' && def[i + 1]?.upper === 'NULL') col.notNull = true;
    else if (t.upper === 'GENERATED' || (t.upper === 'AS' && def[i + 1]?.text === '(')) col.generated = true;
    else if (t.upper === 'COMMENT' && (def[i + 1]?.kind === 'string' || def[i + 1]?.kind === 'qident')) {
      col.comment = def[i + 1].value;
      col.commentFrom = 'comment';
    } else if (t.upper === 'REFERENCES') {
      const ref = readReferences(def, i);
      if (ref) {
        table.foreignKeys.push({ columns: [col.name], refTable: ref.table, refColumns: ref.cols, ref: { file, line: t.line } });
        i = ref.next - 1;
      }
    }
  }
  if (typeToks[0]?.upper === 'AS') col.generated = true; // SQL Server 计算列：name AS (expr)
  if (col.comment === undefined) {
    // 同一行、写在列定义后面的 -- 注释
    const last = def[def.length - 1];
    const c = lineComments.find((x) => x.line === last.line && x.offset > last.offset && x.text.length > 0);
    if (c) {
      col.comment = c.text;
      col.commentFrom = 'line-comment';
    }
  }
  return col;
}

function applyAlter(
  toks: Token[],
  lineComments: Comment[],
  file: string,
  findTable: (name: string, line: number, what: string) => TableFact | undefined,
  issues: Issue[],
): void {
  let i = 2;
  if (toks[i]?.upper === 'ONLY') i++;
  if (toks[i]?.upper === 'IF' && toks[i + 1]?.upper === 'EXISTS') i += 2;
  const qn = readQualifiedName(toks, i);
  if (!qn) return;
  const tname = qn.parts[qn.parts.length - 1];
  const line = toks[0].line;
  const table = findTable(tname, line, 'ALTER TABLE');
  if (!table) return;
  for (const raw of splitTopLevel(toks.slice(qn.next))) {
    // SQL Server：ALTER TABLE x WITH CHECK ADD CONSTRAINT ...
    let action = raw;
    while (action.length && (action[0].upper === 'WITH' || action[0].upper === 'CHECK' || action[0].upper === 'NOCHECK') && action[1]) {
      if (action[0].upper === 'CHECK' && action[1].upper === 'CONSTRAINT') break; // ALTER TABLE x CHECK CONSTRAINT fk：只是启用约束
      action = action.slice(1);
    }
    if (!action.length) continue;
    const a0 = action[0].upper;
    if (a0 === 'ADD') {
      let rest = action.slice(1);
      let cname: string | undefined;
      if (rest[0]?.upper === 'CONSTRAINT') {
        cname = rest[1]?.value;
        rest = rest.slice(2);
      }
      if (rest[0] && CONSTRAINT_START.has(rest[0].upper) && rest[0].kind === 'word') {
        applyConstraint(table, rest, cname, file, issues);
      } else {
        if (rest[0]?.upper === 'COLUMN') rest = rest.slice(1);
        if (rest[0]?.upper === 'IF') rest = rest.slice(3);
        const defs = rest[0]?.text === '(' ? splitTopLevel(rest.slice(1, matchParen(rest, 0))) : [rest];
        for (const d of defs) {
          const col = d.length ? parseColumn(d, lineComments, file, table) : null;
          if (col) table.columns.push(col);
        }
      }
    } else if (a0 === 'COMMENT') {
      const s = action.find((t) => t.kind === 'string');
      if (s) {
        table.comment = s.value;
        table.commentFrom = 'comment';
      }
    } else if (a0 === 'MODIFY' || a0 === 'CHANGE') {
      let rest = action.slice(1);
      if (rest[0]?.upper === 'COLUMN') rest = rest.slice(1);
      const oldName = rest[0]?.value;
      if (a0 === 'CHANGE') rest = rest.slice(1);
      const col = rest.length ? parseColumn(rest, lineComments, file, table) : null;
      const idx = table.columns.findIndex((c) => lower(c.name) === lower(oldName ?? ''));
      if (col && idx >= 0) {
        const prev = table.columns[idx];
        table.columns[idx] = { ...col, pk: col.pk || prev.pk, comment: col.comment ?? prev.comment, commentFrom: col.comment ? col.commentFrom : prev.commentFrom };
      }
    } else if (a0 === 'DROP') {
      let rest = action.slice(1);
      if (rest[0]?.upper === 'COLUMN') rest = rest.slice(1);
      if (rest[0]?.upper === 'IF') rest = rest.slice(2);
      const u = rest[0]?.upper;
      if (u && !['CONSTRAINT', 'FOREIGN', 'PRIMARY', 'INDEX', 'KEY', 'CHECK', 'PARTITION', 'DEFAULT'].includes(u)) {
        const cname = rest[0].value;
        const before = table.columns.length;
        table.columns = table.columns.filter((c) => lower(c.name) !== lower(cname));
        if (table.columns.length !== before) {
          table.foreignKeys = table.foreignKeys.filter((f) => !f.columns.some((c) => lower(c) === lower(cname)));
          issues.push({ level: 'info', code: 'sql.alter.drop', message: `第 ${action[0].line} 行删掉了 ${table.name}.${cname}，已按删除处理`, ref: { file, line: action[0].line } });
        }
      }
    }
  }
}

function parseCommentOn(toks: Token[]): PendingComment | null {
  // COMMENT ON TABLE a.b IS '...' / COMMENT ON COLUMN a.b.c IS '...'
  const kind = toks[2]?.upper;
  const qn = readQualifiedName(toks, 3);
  if (!qn) return null;
  const isTok = toks[qn.next];
  const s = toks[qn.next + 1];
  if (isTok?.upper !== 'IS' || s?.kind !== 'string') return null;
  if (kind === 'TABLE') return { table: qn.parts[qn.parts.length - 1], text: s.value, line: toks[0].line };
  if (kind === 'COLUMN' && qn.parts.length >= 2) return { table: qn.parts[qn.parts.length - 2], column: qn.parts[qn.parts.length - 1], text: s.value, line: toks[0].line };
  return null;
}

function parseCreateUniqueIndex(toks: Token[]): { table: string; cols: string[]; line: number } | null {
  const on = toks.findIndex((t) => t.upper === 'ON');
  if (on < 0) return null;
  let i = on + 1;
  if (toks[i]?.upper === 'ONLY') i++;
  const qn = readQualifiedName(toks, i);
  if (!qn) return null;
  const cl = readColumnList(toks, skipToParen(toks, qn.next));
  if (!cl) return null;
  return { table: qn.parts[qn.parts.length - 1], cols: cl.cols, line: toks[0].line };
}

function parseExtendedProperty(toks: Token[]): PendingComment | null {
  // EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'...', @level0type=..., @level1type=N'TABLE', @level1name=N'x', @level2type=N'COLUMN', @level2name=N'y'
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'param' && toks[i + 1]?.text === '=' && toks[i + 2]) {
      named.set(t.value.slice(1).toLowerCase(), toks[i + 2].value);
      i += 2;
    } else if (t.kind === 'string') positional.push(t.value);
  }
  const keys = ['name', 'value', 'level0type', 'level0name', 'level1type', 'level1name', 'level2type', 'level2name'];
  const get = (k: string) => named.get(k) ?? (named.size === 0 ? positional[keys.indexOf(k)] : undefined);
  if ((get('name') ?? '').toLowerCase() !== 'ms_description') return null;
  const value = get('value');
  const l1 = (get('level1type') ?? '').toUpperCase();
  const l2 = (get('level2type') ?? '').toUpperCase();
  if (value === undefined || l1 !== 'TABLE' || !get('level1name')) return null;
  if (l2 === 'COLUMN' && get('level2name')) return { table: get('level1name')!, column: get('level2name')!, text: value, line: toks[0].line };
  if (!l2) return { table: get('level1name')!, text: value, line: toks[0].line };
  return null;
}

/** 汇总主键、唯一。 */
function finalizeTable(t: TableFact): void {
  for (const c of t.columns) if (c.pk && !t.primaryKey.some((p) => lower(p) === lower(c.name))) t.primaryKey.push(c.name);
  const pkSet = new Set(t.primaryKey.map(lower));
  for (const c of t.columns) if (pkSet.has(lower(c.name))) c.pk = true;
  for (const u of t.uniques) {
    if (u.length === 1) {
      const c = t.columns.find((x) => lower(x.name) === lower(u[0]));
      if (c) c.unique = true;
    }
  }
}
