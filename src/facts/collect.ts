// 输入：文件或文件夹。找出 .sql / .ddl / .py，识别编码，交给对应解析器，合并成一份事实。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FactSet, Issue, SourceFile, TableFact } from './types.js';
import { lower } from './types.js';
import { applyPending, parseSqlText, type PendingChanges } from './sql.js';
import { crossCheck } from './sql-crosscheck.js';
import { parseSqlAlchemy } from './sqlalchemy.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'venv', '.venv', 'env', '.env', '__pycache__', 'site-packages', 'dist', 'build',
  'target', '.idea', '.vscode', '.tox', '.mypy_cache', '.pytest_cache', 'out', 'bin', 'obj', '.next', '.nuxt', 'coverage',
]);

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 相对 baseDir 的路径（正斜杠）；不在同一盘符时保留绝对路径。 */
export function relPath(abs: string, baseDir: string): string {
  const r = path.relative(baseDir, abs);
  return toPosix(r === '' ? path.basename(abs) : path.isAbsolute(r) ? abs : r);
}

/** 读文本并识别编码：UTF-8（含 BOM）、UTF-16（SSMS 导出常见）、其余按 GBK（中文 Windows 上的老脚本）。 */
export function readText(abs: string): { text: string; encoding: string; sha1: string } {
  const buf = fs.readFileSync(abs);
  const sha1 = createHash('sha1').update(buf).digest('hex');
  let text: string;
  let encoding: string;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString('utf8');
    encoding = 'utf-8-bom';
  } else if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
    encoding = 'utf-16le';
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buf.subarray(2));
    encoding = 'utf-16be';
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      encoding = 'utf-8';
    } catch {
      text = new TextDecoder('gb18030').decode(buf);
      encoding = 'gb18030';
    }
  }
  return { text: text.replace(/\r\n?/g, '\n'), encoding, sha1 };
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function walk(abs: string, out: string[]): void {
  const st = fs.statSync(abs);
  if (st.isFile()) {
    out.push(abs);
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(abs).sort(naturalCompare)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = path.join(abs, name);
    let s: fs.Stats;
    try {
      s = fs.statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, out);
    else if (/\.(sql|ddl|py)$/i.test(name)) out.push(p);
  }
}

export async function collectFacts(inputs: string[], baseDir: string): Promise<FactSet> {
  const issues: Issue[] = [];
  const files: SourceFile[] = [];
  const found: string[] = [];
  for (const inp of inputs) {
    const abs = path.resolve(baseDir, inp);
    if (!fs.existsSync(abs)) {
      issues.push({ level: 'error', code: 'input.missing', message: `找不到输入：${inp}` });
      continue;
    }
    walk(abs, found);
  }
  const unique = [...new Set(found)];

  const sqlTables: TableFact[] = [];
  const pending: PendingChanges[] = [];
  const crossInputs: { segs: ReturnType<typeof parseSqlText>['segments']; createOnly: Map<string, TableFact>; file: string }[] = [];
  const pyFiles: { path: string; text: string }[] = [];

  for (const abs of unique) {
    const rel = relPath(abs, baseDir);
    const isSql = /\.(sql|ddl)$/i.test(abs);
    const isPy = /\.py$/i.test(abs);
    if (!isSql && !isPy) {
      issues.push({ level: 'warning', code: 'input.kind', message: `${rel} 不是 .sql / .py 文件，跳过` });
      continue;
    }
    const { text, encoding, sha1 } = readText(abs);
    files.push({ path: rel, sha1, kind: isSql ? 'sql' : 'python', encoding });
    if (encoding === 'gb18030') issues.push({ level: 'info', code: 'input.encoding', message: `${rel} 不是 UTF-8，按 GBK/GB18030 读取` });
    if (isSql) {
      const r = parseSqlText(text, rel);
      // 同名表：后读到的文件覆盖先读到的（迁移脚本按 V1、V2… 顺序）
      for (const t of r.tables) {
        const i = sqlTables.findIndex((x) => lower(x.name) === lower(t.name));
        if (i >= 0) {
          issues.push({ level: 'warning', code: 'sql.create.duplicate', message: `表 ${t.name} 在 ${sqlTables[i].ref.file} 和 ${rel} 都有定义，按后者算`, ref: t.ref });
          sqlTables.splice(i, 1);
        }
        sqlTables.push(t);
      }
      issues.push(...r.issues);
      pending.push(r.pending);
      crossInputs.push({ segs: r.segments, createOnly: r.createOnly, file: rel });
    } else {
      pyFiles.push({ path: rel, text });
    }
  }

  applyPending(sqlTables, pending, issues);
  let crossChecked = 0;
  const crossUnchecked: string[] = [];
  for (const ci of crossInputs) {
    const r = crossCheck(ci.segs, ci.createOnly, ci.file);
    issues.push(...r.issues);
    crossChecked += r.checked;
    crossUnchecked.push(...r.unchecked);
  }
  let pyTables = 0;

  const tables = [...sqlTables];
  if (pyFiles.length) {
    const r = await parseSqlAlchemy(pyFiles);
    issues.push(...r.issues);
    pyTables = r.tables.length;
    for (const t of r.tables) {
      const i = tables.findIndex((x) => lower(x.name) === lower(t.name));
      if (i >= 0) {
        issues.push({ level: 'warning', code: 'input.duplicate-table', message: `表 ${t.name} 在 SQL（${tables[i].ref.file}）和模型（${t.ref.file}）里都有，用 SQL 的定义`, ref: t.ref });
        continue;
      }
      tables.push(t);
    }
    if (!r.tables.length && !sqlTables.length) issues.push({ level: 'info', code: 'python.none', message: `读了 ${pyFiles.length} 个 Python 文件，没有找到 SQLAlchemy 模型` });
  }

  if (!tables.length) issues.push({ level: 'error', code: 'input.empty', message: '没有找到任何表：请给 .sql 建表脚本，或包含 SQLAlchemy 模型的 .py 文件/文件夹' });
  for (const t of tables) {
    if (!t.columns.length) issues.push({ level: 'warning', code: 'table.no-columns', message: `表 ${t.name} 没有列`, ref: t.ref, ids: [t.name] });
  }
  return { tables, issues, files, stats: { sqlTables: sqlTables.length, crossChecked, crossUnchecked, pyTables } };
}
