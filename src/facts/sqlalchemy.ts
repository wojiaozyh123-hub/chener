// SQLAlchemy / Flask-SQLAlchemy / SQLModel 模型读取（用 tree-sitter 解析 Python，不执行代码）。
// 支持：Column / mapped_column / Mapped[...] 注解 / SQLModel Field、__tablename__、__table_args__、
// 抽象基类和 mixin 继承来的列、单表继承、模块级 Table(...) 关联表、行尾 # 注释、类文档字符串。

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { ColumnFact, FkFact, Issue, TableFact } from './types.js';
import { lower } from './types.js';

let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const here = path.dirname(fileURLToPath(import.meta.url));
      const wasm = path.resolve(here, '..', '..', 'grammars', 'tree-sitter-python.wasm');
      const lang = await Language.load(wasm);
      const p = new Parser();
      p.setLanguage(lang);
      return p;
    })();
  }
  return parserPromise;
}

interface PyFile {
  path: string;
  text: string;
}

interface ClassInfo {
  name: string;
  bases: string[];
  baseKeywords: Map<string, string>;
  file: string;
  line: number;
  node: Node; // class_definition
  body: Node;
  bodyText: string;
}

interface RawColumn {
  col: ColumnFact;
  fks: { target: string; line: number }[]; // 'table.col' 或 'Class.attr'
}

const kids = (n: Node | null | undefined): Node[] => (n ? (n.namedChildren.filter(Boolean) as Node[]) : []);

function stringValue(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'concatenated_string') return kids(n).map((k) => stringValue(k) ?? '').join('');
  if (n.type !== 'string') return undefined;
  const m = /^[rRbBuUfF]{0,2}('''|"""|'|")([\s\S]*)\1$/.exec(n.text);
  if (!m) return undefined;
  return m[2].replace(/\\(['"\\])/g, '$1');
}

function callName(n: Node | null | undefined): string | undefined {
  if (!n || n.type !== 'call') return undefined;
  const f = n.childForFieldName('function');
  if (!f) return undefined;
  if (f.type === 'identifier') return f.text;
  if (f.type === 'attribute') return f.childForFieldName('attribute')?.text;
  return undefined;
}

function args(call: Node): { positional: Node[]; keywords: Map<string, Node> } {
  const positional: Node[] = [];
  const keywords = new Map<string, Node>();
  for (const a of kids(call.childForFieldName('arguments'))) {
    if (a.type === 'keyword_argument') {
      const k = a.childForFieldName('name')?.text;
      const v = a.childForFieldName('value');
      if (k && v) keywords.set(k, v);
    } else if (a.type !== 'comment') positional.push(a);
  }
  return { positional, keywords };
}

const isTrue = (n?: Node) => !!n && n.type === 'true';
const isFalse = (n?: Node) => !!n && n.type === 'false';

const COLUMN_CALLS = new Set(['Column', 'mapped_column']);
const NOT_TYPE_CALLS = new Set(['ForeignKey', 'Sequence', 'Identity', 'Computed', 'FetchedValue', 'DefaultClause', 'CheckConstraint']);
const SCALAR_HINT = /^(Optional\[)?\s*(int|str|float|bool|bytes|datetime(\.\w+)?|date|time|timedelta|Decimal|decimal\.Decimal|UUID|uuid\.UUID|dict|Dict\[.*\]|list|List\[(int|str|float)\]|Any|JSON|Enum|[A-Z]\w*Enum)\s*\]?(\s*\|\s*None)?$/;

function snake(name: string): string {
  return name.replace(/((?<=[a-z0-9])[A-Z]|(?!^)[A-Z](?=[a-z]))/g, '_$1').toLowerCase().replace(/^_+/, '');
}

function trailingComment(stmt: Node, block: Node): string | undefined {
  const row = stmt.endPosition.row;
  for (const c of block.children.filter(Boolean) as Node[]) {
    if (c.type === 'comment' && c.startPosition.row === row && c.startIndex >= stmt.endIndex) return c.text.replace(/^#\s?/, '').trim() || undefined;
  }
  // 有时注释挂在语句节点内部
  for (const c of stmt.descendantsOfType('comment').filter(Boolean) as Node[]) {
    if (c.startPosition.row === row) return c.text.replace(/^#\s?/, '').trim() || undefined;
  }
  return undefined;
}

function typeText(n: Node): string {
  if (n.type === 'call') return n.text.replace(/\s+/g, '');
  return n.text;
}

/** 从一次 Column(...) / mapped_column(...) / Field(...) 调用里读出列。 */
function readColumnCall(call: Node, attrName: string, file: string, annotation?: string): RawColumn {
  const fn = callName(call)!;
  const { positional, keywords } = args(call);
  let name = attrName;
  let type = '';
  const fks: { target: string; line: number }[] = [];
  let generated = false;
  const rest = [...positional];
  if (rest.length && stringValue(rest[0]) !== undefined && fn !== 'Field') name = stringValue(rest.shift())!;
  for (const p of rest) {
    const cn = callName(p);
    if (cn === 'ForeignKey') {
      const t = args(p).positional[0];
      if (t) fks.push({ target: stringValue(t) ?? t.text, line: p.startPosition.row + 1 });
    } else if (cn === 'Computed') generated = true;
    else if (!type && !(cn && NOT_TYPE_CALLS.has(cn))) type = typeText(p);
  }
  if (fn === 'Field') {
    const fk = keywords.get('foreign_key');
    if (fk) fks.push({ target: stringValue(fk) ?? fk.text, line: fk.startPosition.row + 1 });
    const sc = keywords.get('sa_column');
    if (sc && COLUMN_CALLS.has(callName(sc) ?? '')) return readColumnCall(sc, attrName, file, annotation);
  }
  const kwStr = (k: string) => {
    const v = keywords.get(k);
    return v ? stringValue(v) : undefined;
  };
  let comment = kwStr('comment');
  let commentFrom: ColumnFact['commentFrom'] = comment ? 'comment' : undefined;
  if (!comment && fn === 'Field') {
    const kw = keywords.get('sa_column_kwargs');
    if (kw?.type === 'dictionary') {
      for (const pair of kids(kw)) {
        if (pair.type === 'pair' && stringValue(pair.childForFieldName('key')) === 'comment') comment = stringValue(pair.childForFieldName('value'));
      }
    }
    comment ??= kwStr('description') ?? kwStr('title');
    if (comment) commentFrom = 'comment';
  }
  if (!comment) {
    comment = kwStr('doc');
    if (comment) commentFrom = 'docstring';
  }
  const nullable = keywords.get('nullable');
  const col: ColumnFact = {
    name,
    type: type || annotation || '',
    comment,
    commentFrom,
    pk: isTrue(keywords.get('primary_key')),
    unique: isTrue(keywords.get('unique')),
    notNull: isFalse(nullable) || isTrue(keywords.get('primary_key')),
    generated: generated || undefined,
    ref: { file, line: call.startPosition.row + 1 },
  };
  return { col, fks };
}

function mappedInner(annotation: string): string | undefined {
  const m = /^Mapped\[\s*([\s\S]+)\s*\]$/.exec(annotation.trim());
  return m ? m[1].trim() : undefined;
}

interface ClassBody {
  tablename?: string;
  abstract: boolean;
  tableComment?: string;
  docstring?: string;
  columns: RawColumn[];
  uniques: string[][];
  pk: string[];
  fkConstraints: { cols: string[]; targets: string[]; line: number }[];
  explicitCount: number;
  hasTableArgs: boolean;
  /** @declared_attr def __tablename__ 的算法：lower = cls.__name__.lower()，snake = 蛇形，unknown = 看不出 */
  declaredTablename?: 'lower' | 'snake' | 'unknown';
}

/** 模块级 intpk = Annotated[int, mapped_column(primary_key=True)] 这类类型别名 */
type AliasMap = Map<string, ColumnFact>;

function readTableArgs(n: Node, body: ClassBody): void {
  const visitItem = (it: Node) => {
    if (it.type === 'dictionary') {
      for (const pair of kids(it)) {
        if (pair.type === 'pair' && stringValue(pair.childForFieldName('key')) === 'comment') body.tableComment = stringValue(pair.childForFieldName('value'));
      }
      return;
    }
    const cn = callName(it);
    if (!cn) return;
    const { positional } = args(it);
    const strs = (xs: Node[]) => xs.map((x) => stringValue(x) ?? x.text.replace(/^.*\./, ''));
    if (cn === 'UniqueConstraint') body.uniques.push(strs(positional));
    else if (cn === 'PrimaryKeyConstraint') body.pk.push(...strs(positional));
    else if (cn === 'ForeignKeyConstraint' && positional.length >= 2) {
      const list = (x: Node) => (x.type === 'list' || x.type === 'tuple' ? strs(kids(x)) : strs([x]));
      body.fkConstraints.push({ cols: list(positional[0]), targets: list(positional[1]), line: it.startPosition.row + 1 });
    }
  };
  if (n.type === 'tuple' || n.type === 'list' || n.type === 'parenthesized_expression') for (const it of kids(n)) visitItem(it);
  else visitItem(n);
}

function readClassBody(cls: ClassInfo, isSqlModelTable: boolean, mappedClassNames: Set<string>, aliases: AliasMap): ClassBody {
  const body: ClassBody = { abstract: false, columns: [], uniques: [], pk: [], fkConstraints: [], explicitCount: 0, hasTableArgs: false };
  const stmts = kids(cls.body);
  if (stmts[0]?.type === 'expression_statement') {
    const s = kids(stmts[0])[0];
    const v = stringValue(s);
    if (v) body.docstring = v.trim().split('\n')[0].trim() || undefined;
  }
  for (const st of stmts) {
    if (st.type === 'decorated_definition' && /declared_attr/.test(st.text)) {
      const fn = st.childForFieldName('definition');
      if (fn?.type === 'function_definition' && fn.childForFieldName('name')?.text === '__tablename__') {
        const src = fn.childForFieldName('body')?.text ?? '';
        body.declaredTablename = /re\.sub|snake|camel/.test(src) ? 'snake' : /__name__\.lower\(\)/.test(src) ? 'lower' : 'unknown';
      }
      continue;
    }
    if (st.type !== 'expression_statement') continue;
    const a = kids(st)[0];
    if (!a || a.type !== 'assignment') continue;
    const left = a.childForFieldName('left');
    const right = a.childForFieldName('right');
    const annotation = a.childForFieldName('type')?.text;
    if (!left || left.type !== 'identifier') continue;
    const attr = left.text;
    if (attr === '__tablename__') {
      body.tablename = stringValue(right);
      continue;
    }
    if (attr === '__abstract__') {
      body.abstract = isTrue(right ?? undefined);
      continue;
    }
    if (attr === '__table_args__' && right) {
      body.hasTableArgs = true;
      readTableArgs(right, body);
      continue;
    }
    if (attr.startsWith('__')) continue;
    const cn = callName(right);
    let raw: RawColumn | null = null;
    if (right && cn && (COLUMN_CALLS.has(cn) || (cn === 'Field' && isSqlModelTable))) {
      raw = readColumnCall(right, attr, cls.file, annotation ? mappedInner(annotation) ?? annotation : undefined);
      body.explicitCount++;
    } else if (!right && annotation) {
      // 只有注解：SQLAlchemy 2.0 的 Mapped[int]，或 SQLModel 表类里的普通注解
      const inner = mappedInner(annotation);
      const t = inner ?? (isSqlModelTable ? annotation : undefined);
      const bare = t?.replace(/^['"]|['"]$/g, '');
      const aliasName = bare?.replace(/^Optional\[\s*|\s*\]$|\s*\|\s*None$/g, '');
      const alias = aliasName ? aliases.get(aliasName) : undefined;
      const isCollection = !!bare && /^(List|list|Set|set|Sequence|Tuple|tuple|Dict|dict)\[\s*['"A-Z]/.test(bare);
      if (alias) {
        raw = { col: { ...alias, name: attr, notNull: alias.notNull || !/Optional|None/.test(t!), ref: { file: cls.file, line: st.startPosition.row + 1 } }, fks: [] };
      } else if (t && bare && !isCollection && !mappedClassNames.has(bare) && (SCALAR_HINT.test(t) || (inner !== undefined && /^[a-z_][\w.]*$/.test(bare)))) {
        raw = {
          col: { name: attr, type: t, pk: false, unique: false, notNull: !/Optional|None/.test(t), ref: { file: cls.file, line: st.startPosition.row + 1 } },
          fks: [],
        };
      }
    }
    if (!raw) continue;
    if (!raw.col.comment) {
      const tc = trailingComment(st, cls.body);
      if (tc) {
        raw.col.comment = tc;
        raw.col.commentFrom = 'line-comment';
      }
    }
    body.columns.push(raw);
  }
  return body;
}

/** 不依赖语法树的独立计数：类体原文里出现了几次 Column( / mapped_column( / Field(。 */
function regexCount(text: string, isSqlModelTable: boolean): number {
  let n = 0;
  const re = isSqlModelTable ? /\b(?:Column|mapped_column|Field)\s*\(/g : /\b(?:Column|mapped_column)\s*\(/g;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, (m) => (/['"]/.test(m) ? m : ''));
    if (/^\s*(__table_args__|#)/.test(raw)) continue;
    n += (line.match(re) ?? []).length;
  }
  return n;
}

export async function parseSqlAlchemy(files: PyFile[]): Promise<{ tables: TableFact[]; issues: Issue[] }> {
  const parser = await getParser();
  const issues: Issue[] = [];
  const classes: ClassInfo[] = [];
  const roots = new Set<string>();
  const moduleTables: { call: Node; file: string }[] = [];
  const aliases: AliasMap = new Map();
  const trees: { tree: NonNullable<ReturnType<Parser["parse"]>>; file: string }[] = [];

  for (const f of files) {
    if (!/\b(sqlalchemy|SQLAlchemy|sqlmodel|flask_sqlalchemy|mapped_column|Column\s*\()/.test(f.text)) continue;
    const tree = parser.parse(f.text);
    if (!tree) continue;
    trees.push({ tree, file: f.path });
    const visit = (n: Node) => {
      if (n.type === 'class_definition') {
        const body = n.childForFieldName('body');
        const sup = n.childForFieldName('superclasses');
        const bases: string[] = [];
        const baseKeywords = new Map<string, string>();
        for (const b of kids(sup)) {
          if (b.type === 'keyword_argument') {
            const k = b.childForFieldName('name')?.text;
            const v = b.childForFieldName('value')?.text;
            if (k && v) baseKeywords.set(k, v);
          } else bases.push(b.text);
        }
        if (body) classes.push({ name: n.childForFieldName('name')!.text, bases, baseKeywords, file: f.path, line: n.startPosition.row + 1, node: n, body, bodyText: body.text });
        return; // 嵌套类不算模型
      }
      if (n.type === 'expression_statement' && n.parent?.type === 'module') {
        const a = kids(n)[0];
        if (a?.type === 'assignment') {
          const r = a.childForFieldName('right');
          const cn = callName(r);
          const left = a.childForFieldName('left')?.text;
          if (cn && left && /^(declarative_base|automap_base|generate_base)$/.test(cn)) roots.add(left);
          if (cn === 'SQLAlchemy' && left) roots.add(`${left}.Model`);
          if (cn === 'Table' && r) moduleTables.push({ call: r, file: f.path });
          if (left && r?.type === 'subscript' && /(^|\.)Annotated$/.test(r.childForFieldName('value')?.text ?? '')) {
            const mc = (r.descendantsOfType('call').filter(Boolean) as Node[]).find((x) => callName(x) === 'mapped_column');
            const first = kids(r).find((x) => x !== r.childForFieldName('value'));
            if (mc) {
              const rc = readColumnCall(mc, left, f.path, first?.text);
              aliases.set(left, { ...rc.col, type: rc.col.type || first?.text || '' });
            }
          }
        }
      }
      for (const c of kids(n)) visit(c);
    };
    visit(tree.rootNode);
  }

  const byName = new Map<string, ClassInfo[]>();
  for (const c of classes) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const findClass = (name: string, from: ClassInfo): ClassInfo | undefined => {
    const short = name.replace(/^.*\./, '');
    const list = byName.get(short);
    if (!list) return undefined;
    return list.find((c) => c.file === from.file) ?? list[0];
  };
  const isRoot = (b: string) =>
    roots.has(b) || /(^|\.)Model$/.test(b) || /^(\w+\.)?(DeclarativeBase|DeclarativeBaseNoMeta|SQLModel)$/.test(b);

  const familyMemo = new Map<ClassInfo, boolean>();
  const inFamily = (c: ClassInfo, seen = new Set<ClassInfo>()): boolean => {
    if (familyMemo.has(c)) return familyMemo.get(c)!;
    if (seen.has(c)) return false;
    seen.add(c);
    const r = c.bases.some((b) => isRoot(b) || (() => {
      const p = findClass(b, c);
      return !!p && inFamily(p, seen);
    })());
    familyMemo.set(c, r);
    return r;
  };
  const isSqlModel = (c: ClassInfo, seen = new Set<ClassInfo>()): boolean => {
    if (seen.has(c)) return false;
    seen.add(c);
    return c.bases.some((b) => /(^|\.)SQLModel$/.test(b) || (() => {
      const p = findClass(b, c);
      return !!p && isSqlModel(p, seen);
    })());
  };

  const family = classes.filter((c) => inFamily(c));
  const familyNames = new Set(family.map((c) => c.name));
  const bodies = new Map<ClassInfo, ClassBody>();
  const bodyOf = (c: ClassInfo) => {
    if (!bodies.has(c)) {
      const sqlTable = isSqlModel(c) && c.baseKeywords.get('table') === 'True';
      bodies.set(c, readClassBody(c, sqlTable, familyNames, aliases));
    }
    return bodies.get(c)!;
  };

  // 哪些类有自己的表
  const tableOf = new Map<ClassInfo, string>();
  const concreteParent = (c: ClassInfo): ClassInfo | undefined => {
    for (const b of c.bases) {
      const p = findClass(b, c);
      if (p && inFamily(p) && tableOf.has(p)) return p;
    }
    return undefined;
  };
  // 按继承深度排序，父类先定
  const depth = (c: ClassInfo, seen = new Set<ClassInfo>()): number => {
    if (seen.has(c)) return 0;
    seen.add(c);
    let d = 0;
    for (const b of c.bases) {
      const p = findClass(b, c);
      if (p) d = Math.max(d, depth(p, seen) + 1);
    }
    return d;
  };
  const ordered = [...family].sort((a, b) => depth(a) - depth(b));
  const ancestors = (c: ClassInfo): ClassInfo[] => {
    const out: ClassInfo[] = [];
    const walk = (k: ClassInfo) => {
      for (const b of k.bases) {
        const p = findClass(b, k);
        if (p && !out.includes(p)) {
          out.push(p);
          walk(p);
        }
      }
    };
    walk(c);
    return out;
  };
  const isFlask = (c: ClassInfo) => [c, ...ancestors(c)].some((k) => k.bases.some((x) => /(^|\.)Model$/.test(x) && isRoot(x)));
  const declaredAttr = (c: ClassInfo) => {
    for (const k of [c, ...ancestors(c)]) {
      const d = bodyOf(k).declaredTablename;
      if (d) return d;
    }
    return undefined;
  };
  const stiChildren = new Map<ClassInfo, ClassInfo[]>();
  for (const c of ordered) {
    const b = bodyOf(c);
    if (b.abstract) continue;
    const sqlModel = isSqlModel(c);
    if (sqlModel && c.baseKeywords.get('table') !== 'True') continue;
    if (b.tablename) {
      tableOf.set(c, b.tablename);
      continue;
    }
    const parent = concreteParent(c);
    const ownPk = b.columns.some((x) => x.col.pk);
    if (parent && !ownPk) {
      stiChildren.set(parent, [...(stiChildren.get(parent) ?? []), c]);
      continue;
    }
    if (sqlModel) {
      tableOf.set(c, c.name.toLowerCase()); // SQLModel 默认表名 = 类名小写
      continue;
    }
    if (isFlask(c)) {
      tableOf.set(c, snake(c.name)); // Flask-SQLAlchemy 默认表名 = 类名转蛇形
      continue;
    }
    const da = declaredAttr(c);
    if (da) {
      const name = da === 'lower' ? c.name.toLowerCase() : snake(c.name);
      tableOf.set(c, name);
      if (da === 'unknown') issues.push({ level: 'warning', code: 'sqlalchemy.tablename.guess', message: `${c.name} 的表名由 declared_attr 计算，看不出规则，按蛇形 ${name} 处理；外键对不上时请写明 __tablename__`, ref: { file: c.file, line: c.line } });
      continue;
    }
    // 直接继承 DeclarativeBase 又没有 __tablename__ 的是项目自己的 Base，不是表
    if (b.columns.length) issues.push({ level: 'warning', code: 'sqlalchemy.no-tablename', message: `${c.name} 有列但没有 __tablename__，没有当成表`, ref: { file: c.file, line: c.line } });
  }

  // 收集某个类自己和祖先（抽象类、mixin）上的列；祖先在前
  // 自己的列在前，继承来的（抽象基类、mixin）在后；子类重新定义的同名列以子类为准
  const collectColumns = (c: ClassInfo): RawColumn[] => {
    const inherited: RawColumn[] = [];
    const seen = new Set<ClassInfo>([c]);
    const walk = (k: ClassInfo) => {
      for (const base of k.bases) {
        const p = findClass(base, k);
        if (!p || seen.has(p)) continue;
        seen.add(p);
        if (tableOf.has(p)) continue; // 有自己表的父类（联表继承）不把列抄过来
        for (const rc of bodyOf(p).columns) if (!inherited.some((x) => lower(x.col.name) === lower(rc.col.name))) inherited.push({ ...rc, col: { ...rc.col } });
        walk(p);
      }
    };
    walk(c);
    const own = bodyOf(c).columns;
    return [...own, ...inherited.filter((x) => !own.some((o) => lower(o.col.name) === lower(x.col.name)))];
  };

  const classTable = new Map<string, string>();
  for (const [c, t] of tableOf) classTable.set(c.name, t);
  const tableNames = new Set([...tableOf.values()]);
  /** ForeignKey('user.id') → user；ForeignKey(User.id) → User 类的表 */
  const resolveTarget = (target: string): { table: string; col: string } | null => {
    const s = target.replace(/^['"]|['"]$/g, '');
    const parts = s.split('.');
    if (parts.length < 2) return null;
    const col = parts[parts.length - 1];
    const head = parts[parts.length - 2];
    if (classTable.has(head) && !tableNames.has(head)) return { table: classTable.get(head)!, col };
    return { table: head, col };
  };

  const tables: TableFact[] = [];
  for (const [c, tname] of tableOf) {
    const b = bodyOf(c);
    const raws = collectColumns(c);
    for (const kid of stiChildren.get(c) ?? []) {
      for (const rc of bodyOf(kid).columns) if (!raws.some((x) => lower(x.col.name) === lower(rc.col.name))) raws.push(rc);
      issues.push({ level: 'info', code: 'sqlalchemy.sti', message: `${kid.name} 是 ${c.name} 的单表继承，列并入表 ${tname}`, ref: { file: kid.file, line: kid.line } });
    }
    const t: TableFact = {
      name: tname,
      comment: b.tableComment ?? b.docstring,
      commentFrom: b.tableComment ? 'comment' : b.docstring ? 'docstring' : undefined,
      columns: raws.map((r) => r.col),
      primaryKey: [],
      uniques: [...b.uniques],
      foreignKeys: [],
      ref: { file: c.file, line: c.line },
      origin: 'sqlalchemy',
      className: c.name,
    };
    for (const r of raws) {
      for (const fk of r.fks) {
        const tg = resolveTarget(fk.target);
        if (tg) t.foreignKeys.push({ columns: [r.col.name], refTable: tg.table, refColumns: [tg.col], ref: { file: c.file, line: fk.line } });
        else issues.push({ level: 'warning', code: 'sqlalchemy.fk.unresolved', message: `${c.name}.${r.col.name} 的 ForeignKey(${fk.target}) 看不出目标表`, ref: { file: c.file, line: fk.line } });
      }
    }
    for (const fc of b.fkConstraints) {
      const tgs = fc.targets.map((x) => resolveTarget(x));
      const first = tgs[0];
      if (first) t.foreignKeys.push({ columns: fc.cols, refTable: first.table, refColumns: tgs.map((x) => x?.col ?? ''), ref: { file: c.file, line: fc.line } } as FkFact);
    }
    for (const r of raws) if (r.col.pk) t.primaryKey.push(r.col.name);
    for (const p of b.pk) if (!t.primaryKey.includes(p)) t.primaryKey.push(p);
    for (const col of t.columns) if (t.primaryKey.includes(col.name)) col.pk = true;
    for (const u of t.uniques) if (u.length === 1) {
      const col = t.columns.find((x) => x.name === u[0]);
      if (col) col.unique = true;
    }

    // 独立计数核对：语法树读到的显式列定义数 = 原文里 Column(/mapped_column( 的出现次数
    const sqlTable = isSqlModel(c) && c.baseKeywords.get('table') === 'True';
    const expected = regexCount(c.bodyText, sqlTable);
    if (expected !== b.explicitCount) {
      issues.push({
        level: 'error',
        code: 'sqlalchemy.count.mismatch',
        message: `${c.name}（${c.file} 第 ${c.line} 行）类体里出现 ${expected} 处列定义调用，只读到 ${b.explicitCount} 列；可能有列写在 if/for 里或用了不认识的写法，请检查`,
        ref: { file: c.file, line: c.line },
        ids: [tname],
      });
    }
    tables.push(t);
  }

  // 模块级 Table('name', metadata, Column(...), ...)
  for (const mt of moduleTables) {
    const { positional, keywords } = args(mt.call);
    const tname = stringValue(positional[0]);
    if (!tname) continue;
    const t: TableFact = {
      name: tname,
      comment: keywords.get('comment') ? stringValue(keywords.get('comment')) : undefined,
      commentFrom: keywords.get('comment') ? 'comment' : undefined,
      columns: [],
      primaryKey: [],
      uniques: [],
      foreignKeys: [],
      ref: { file: mt.file, line: mt.call.startPosition.row + 1 },
      origin: 'sqlalchemy',
    };
    let explicit = 0;
    for (const p of positional.slice(1)) {
      const cn = callName(p);
      if (cn === 'Column') {
        explicit++;
        const rc = readColumnCall(p, '', mt.file);
        if (!rc.col.name) continue;
        t.columns.push(rc.col);
        if (rc.col.pk) t.primaryKey.push(rc.col.name);
        for (const fk of rc.fks) {
          const tg = resolveTarget(fk.target);
          if (tg) t.foreignKeys.push({ columns: [rc.col.name], refTable: tg.table, refColumns: [tg.col], ref: { file: mt.file, line: fk.line } });
        }
      } else if (cn === 'UniqueConstraint') t.uniques.push(args(p).positional.map((x) => stringValue(x) ?? x.text));
      else if (cn === 'PrimaryKeyConstraint') t.primaryKey.push(...args(p).positional.map((x) => stringValue(x) ?? x.text));
    }
    const expected = (mt.call.text.match(/\bColumn\s*\(/g) ?? []).length;
    if (expected !== explicit) {
      issues.push({ level: 'error', code: 'sqlalchemy.count.mismatch', message: `Table('${tname}')（${mt.file} 第 ${t.ref.line} 行）出现 ${expected} 处 Column(，只读到 ${explicit} 列`, ref: t.ref, ids: [tname] });
    }
    for (const col of t.columns) if (t.primaryKey.includes(col.name)) col.pk = true;
    tables.push(t);
  }

  for (const { tree } of trees) tree.delete();
  return { tables, issues };
}
