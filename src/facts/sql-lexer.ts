// SQL 语句切分和词法。覆盖 MySQL / MariaDB / PostgreSQL / SQLite / SQL Server / Oracle 的建表脚本：
// 字符串、反引号/双引号/方括号标识符、-- # /* */ 注释、MySQL 的 DELIMITER、PostgreSQL 的 $$ 引号、SQL Server 的 GO 分批。

export type TokenKind = 'word' | 'qident' | 'string' | 'number' | 'punct' | 'op' | 'param';

export interface Token {
  kind: TokenKind;
  text: string; // 原文
  value: string; // 去掉引号、转义后的值
  upper: string; // 关键字比较用
  line: number;
  offset: number; // 在语句文本里的位置
  end: number;
}

export interface Comment {
  line: number;
  offset: number;
  text: string;
}

export interface RawStatement {
  text: string;
  startLine: number; // text 第一个字符所在行
  startOffset: number; // 在整个文件里的位置
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿@$#]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_\u0080-￿$#]/.test(c);

function hashStartsComment(src: string, i: number): boolean {
  // MySQL 的 # 注释；SQL Server 的 #临时表 不是注释
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--;
  if (j < 0 || src[j] === '\n') return true;
  const next = src[i + 1] ?? '';
  return next === '' || /\s/.test(next);
}

function dollarTag(src: string, i: number): string | null {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
  return m ? m[0] : null;
}

/** 按分隔符切语句。分隔符只在字符串和注释之外生效。 */
export function splitStatements(src: string): RawStatement[] {
  const out: RawStatement[] = [];
  const n = src.length;
  let delim = ';';
  let i = 0;
  let line = 1;
  let start = 0;
  let startLine = 1;
  let significant = false; // 当前语句已出现非空白、非注释字符

  const push = (endExclusive: number) => {
    const text = src.slice(start, endExclusive);
    if (text.trim().length > 0 && significant) out.push({ text, startLine, startOffset: start });
    significant = false;
  };
  const begin = (pos: number, ln: number) => {
    start = pos;
    startLine = ln;
  };

  while (i < n) {
    const c = src[i];
    const atLineStart = i === 0 || src[i - 1] === '\n';

    if (c === '\n') {
      line++;
      i++;
      continue;
    }

    // SQL Server：单独一行的 GO 结束一批
    if (atLineStart) {
      const m = /^[ \t]*GO[ \t]*(\d+)?[ \t]*(?=\r?\n|$)/i.exec(src.slice(i, i + 32));
      if (m) {
        push(i);
        i += m[0].length;
        begin(i, line);
        continue;
      }
    }

    // MySQL：DELIMITER $$
    if (!significant && /^DELIMITER[ \t]+/i.test(src.slice(i, i + 12))) {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      const nd = src.slice(i, j).replace(/^DELIMITER[ \t]+/i, '').trim();
      if (nd) delim = nd;
      i = j;
      begin(i, line);
      continue;
    }

    // 注释
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && hashStartsComment(src, i)) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (!significant) {
      significant = true;
      // 语句从第一个有效字符开始，前面的注释和空白不算
      begin(i, line);
    }

    // 字符串与带引号的标识符
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n) {
        const d = src[i];
        if (d === '\n') line++;
        if (d === '\\' && c === "'" && (src[i + 1] === "'" || src[i + 1] === '\\')) {
          i += 2;
          continue;
        }
        if (d === c) {
          if (src[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = dollarTag(src, i);
      if (tag) {
        const close = src.indexOf(tag, i + tag.length);
        const stop = close < 0 ? n : close + tag.length;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        continue;
      }
    }

    if (src.startsWith(delim, i)) {
      push(i);
      i += delim.length;
      begin(i, line);
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

/** 把一条语句切成词。行号从 startLine 起算，同时收集注释（用来找列后面的 -- 说明）。 */
export function tokenize(text: string, startLine: number): { tokens: Token[]; comments: Comment[] } {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const n = text.length;
  let i = 0;
  let line = startLine;

  const add = (kind: TokenKind, s: number, e: number, value: string, ln: number) => {
    const t = text.slice(s, e);
    tokens.push({ kind, text: t, value, upper: kind === 'word' ? value.toUpperCase() : t.toUpperCase(), line: ln, offset: s, end: e });
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ((c === '-' && text[i + 1] === '-') || (c === '#' && hashStartsComment(text, i))) {
      const s = i;
      while (i < n && text[i] !== '\n') i++;
      comments.push({ line, offset: s, text: text.slice(s, i).replace(/^(--|#)\s?/, '').trim() });
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const s = i;
      const ln = line;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
      const body = text.slice(s + 2, i - 2);
      if (!body.startsWith('!')) comments.push({ line: ln, offset: s, text: body.trim() });
      continue;
    }

    // 带引号
    if (c === "'" || c === '"' || c === '`') {
      const s = i;
      const ln = line;
      i++;
      let v = '';
      while (i < n) {
        const d = text[i];
        if (d === '\n') line++;
        if (d === '\\' && c === "'" && i + 1 < n) {
          const e = text[i + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '' : e;
          i += 2;
          continue;
        }
        if (d === c) {
          if (text[i + 1] === c) {
            v += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += d;
        i++;
      }
      // N'..' / E'..' / _utf8mb4'..' 前缀：并进字符串
      const prev = tokens[tokens.length - 1];
      if (c === "'" && prev && prev.kind === 'word' && prev.end === s && /^(N|E|X|B|_[A-Za-z0-9]+)$/i.test(prev.text)) {
        tokens.pop();
        add('string', prev.offset, i, v, prev.line);
        continue;
      }
      add(c === "'" ? 'string' : c === '"' ? 'qident' : 'qident', s, i, v, ln);
      continue;
    }
    if (c === '[') {
      const m = /^\[([^\]\n]+)\]/.exec(text.slice(i, i + 256));
      if (m && !/^\s*$/.test(m[1])) {
        add('qident', i, i + m[0].length, m[1], line);
        i += m[0].length;
        continue;
      }
    }
    if (c === '$') {
      const tag = dollarTag(text, i);
      if (tag) {
        const s = i;
        const ln = line;
        const close = text.indexOf(tag, i + tag.length);
        const stop = close < 0 ? n : close + tag.length;
        const v = text.slice(i + tag.length, close < 0 ? n : close);
        for (let k = i; k < stop; k++) if (text[k] === '\n') line++;
        i = stop;
        add('string', s, i, v, ln);
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const s = i;
      while (i < n && /[0-9.eE]/.test(text[i])) i++;
      add('number', s, i, text.slice(s, i), line);
      continue;
    }
    if (c === '@') {
      const s = i;
      i++;
      while (i < n && (isWordChar(text[i]) || text[i] === '@')) i++;
      add('param', s, i, text.slice(s, i), line);
      continue;
    }
    if (isWordStart(c)) {
      const s = i;
      i++;
      while (i < n && isWordChar(text[i])) i++;
      add('word', s, i, text.slice(s, i), line);
      continue;
    }
    if ('(),;.'.includes(c)) {
      add('punct', i, i + 1, c, line);
      i++;
      continue;
    }
    if (c === ':' && text[i + 1] === ':') {
      add('op', i, i + 2, '::', line);
      i += 2;
      continue;
    }
    add('op', i, i + 1, c, line);
    i++;
  }
  return { tokens, comments };
}

/** 从 tokens[i] 起读一个可能带 schema 前缀的名字，返回最后一段和各段。 */
export function readQualifiedName(tokens: Token[], i: number): { parts: string[]; next: number } | null {
  const parts: string[] = [];
  let j = i;
  const isName = (t?: Token) => !!t && (t.kind === 'word' || t.kind === 'qident');
  if (!isName(tokens[j])) return null;
  parts.push(tokens[j].value);
  j++;
  while (tokens[j]?.text === '.' && isName(tokens[j + 1])) {
    parts.push(tokens[j + 1].value);
    j += 2;
  }
  return { parts, next: j };
}

/** tokens[i] 是 '('，返回匹配的 ')' 下标；没有就返回 -1。 */
export function matchParen(tokens: Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j].text === '(' && tokens[j].kind === 'punct') depth++;
    else if (tokens[j].text === ')' && tokens[j].kind === 'punct') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** 按最外层逗号切分。 */
export function splitTopLevel(tokens: Token[], sep = ','): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'punct' && t.text === '(') depth++;
    if (t.kind === 'punct' && t.text === ')') depth--;
    if (depth === 0 && t.kind === 'punct' && t.text === sep) {
      out.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}
