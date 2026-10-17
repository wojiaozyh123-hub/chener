// 读回在 draw.io 里改过的文件：按 id 对上 chener 的节点和连线，把位置、名字、形状、字体、基数、虚线的改动变成修改操作。
// ER 结构以源码为准：draw.io 里新画的图形、删掉的图形、改了端点的线不会改结构，只如实列出来。

import { inflateRawSync } from 'node:zlib';
import type { Diagram } from '../layout/diagram.js';
import type { ShapeKind } from '../layout/shapes.js';
import type { Model } from '../model/types.js';
import type { Op } from '../model/ops.js';
import { DRAWIO_EDGE, DRAWIO_NODE } from './drawio.js';

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  parent?: XNode;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 极简 XML 解析：只要元素和属性，文本内容忽略。 */
function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  let cur = root;
  const src = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [, close, name, attrText, self] = m;
    if (close) {
      if (cur.parent) cur = cur.parent;
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(attrText))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
    const node: XNode = { name, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (!self) cur = node;
  }
  return root;
}

function walk(n: XNode, f: (x: XNode) => void): void {
  f(n);
  for (const c of n.children) walk(c, f);
}

/** 取出图模型：未压缩的 <mxGraphModel>，或 draw.io 压缩格式（base64 + raw deflate + URI 编码）。 */
function graphModel(xml: string): XNode {
  const root = parseXml(xml);
  let model: XNode | null = null;
  walk(root, (x) => {
    if (!model && x.name === 'mxGraphModel') model = x;
  });
  if (model) return model;
  const m = /<diagram[^>]*>([\s\S]*?)<\/diagram>/.exec(xml);
  if (m && m[1].trim()) {
    const raw = inflateRawSync(Buffer.from(m[1].trim(), 'base64')).toString('utf8');
    const inner = parseXml(decodeURIComponent(raw));
    let mm: XNode | null = null;
    walk(inner, (x) => {
      if (!mm && x.name === 'mxGraphModel') mm = x;
    });
    if (mm) return mm;
  }
  throw new Error('读不出 draw.io 图：文件里没有 mxGraphModel');
}

interface Cell {
  id: string;
  value: string;
  style: Record<string, string>;
  vertex: boolean;
  edge: boolean;
  parent?: string;
  source?: string;
  target?: string;
  geo?: { x: number; y: number; w: number; h: number };
}

function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    if (!part.trim()) continue;
    const i = part.indexOf('=');
    if (i < 0) out[part.trim()] = '1';
    else out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function cells(model: XNode): Cell[] {
  const out: Cell[] = [];
  walk(model, (x) => {
    if (x.name !== 'mxCell') return;
    const wrap = x.parent && (x.parent.name === 'object' || x.parent.name === 'UserObject') ? x.parent : null;
    const id = wrap?.attrs.id ?? x.attrs.id;
    if (!id) return;
    const g = x.children.find((c) => c.name === 'mxGeometry');
    out.push({
      id,
      value: wrap?.attrs.label ?? x.attrs.value ?? '',
      style: parseStyle(x.attrs.style ?? ''),
      vertex: x.attrs.vertex === '1',
      edge: x.attrs.edge === '1',
      parent: x.attrs.parent,
      source: x.attrs.source,
      target: x.attrs.target,
      geo: g ? { x: Number(g.attrs.x ?? 0), y: Number(g.attrs.y ?? 0), w: Number(g.attrs.width ?? 0), h: Number(g.attrs.height ?? 0) } : undefined,
    });
  });
  return out;
}

function shapeOf(st: Record<string, string>): ShapeKind {
  const dbl = st.double === '1';
  if ('rhombus' in st || st.shape === 'rhombus') return dbl ? 'double-diamond' : 'diamond';
  if ('ellipse' in st || st.shape === 'ellipse' || st.shape === 'doubleEllipse') {
    if (st.shape === 'doubleEllipse' || dbl) return 'double-ellipse';
    return st.dashed === '1' ? 'dashed-ellipse' : 'ellipse';
  }
  if (st.shape === 'ext' && dbl) return 'double-rect';
  if (st.rounded === '1') return 'rounded-rect';
  return 'rect';
}

export interface DrawioImport {
  ops: Op[];
  notes: string[];
}

/** 和当前画面对比，生成修改操作。 */
export function diffDrawio(xml: string, d: Diagram, model: Model): DrawioImport {
  const all = cells(graphModel(xml));
  const byId = new Map(all.map((c) => [c.id, c] as const));
  const ops: Op[] = [];
  const notes: string[] = [];
  // 图形在分组/容器里时坐标是相对父图形的
  const abs = (c: Cell): { x: number; y: number } => {
    let x = c.geo?.x ?? 0;
    let y = c.geo?.y ?? 0;
    let p = c.parent ? byId.get(c.parent) : undefined;
    for (let guard = 0; p && p.vertex && guard < 50; guard++) {
      x += p.geo?.x ?? 0;
      y += p.geo?.y ?? 0;
      p = p.parent ? byId.get(p.parent) : undefined;
    }
    return { x, y };
  };
  const seen = new Set<string>();
  let unknownShapes = 0;
  for (const c of all.filter((x) => x.vertex)) {
    if (!c.id.startsWith(DRAWIO_NODE)) {
      unknownShapes++;
      continue;
    }
    const id = c.id.slice(DRAWIO_NODE.length);
    const n = d.byId.get(id);
    if (!n) {
      unknownShapes++;
      continue;
    }
    seen.add(id);
    if (c.geo) {
      const p = abs(c);
      const cx = p.x + c.geo.w / 2;
      const cy = p.y + c.geo.h / 2;
      if (Math.abs(cx - n.x) > 0.5 || Math.abs(cy - n.y) > 0.5) ops.push({ op: 'place', id, x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10 });
    }
    const label = stripHtml(c.value);
    if (label && label !== n.label) ops.push({ op: 'rename', id, label });
    const shape = shapeOf(c.style);
    if (shape !== n.shape) ops.push({ op: 'set_shape', id, shape });
    const st: { fontFamily?: string; fontSize?: number; bold?: boolean } = {};
    if (c.style.fontFamily && c.style.fontFamily !== n.family) st.fontFamily = c.style.fontFamily;
    if (c.style.fontSize && Number(c.style.fontSize) !== n.size) st.fontSize = Number(c.style.fontSize);
    const bold = ((Number(c.style.fontStyle ?? 0) | 0) & 1) === 1;
    if (bold !== n.bold) st.bold = bold;
    if (Object.keys(st).length) ops.push({ op: 'set_style', id, ...st });
  }
  const relById = new Map(model.relationships.map((r) => [r.id, r] as const));
  const dashedDone = new Set<string>();
  let unknownEdges = 0;
  let rewired = 0;
  for (const c of all.filter((x) => x.edge)) {
    const e = c.id.startsWith(DRAWIO_EDGE) ? d.edges.find((x) => x.id === c.id.slice(DRAWIO_EDGE.length)) : undefined;
    if (!e) {
      unknownEdges++;
      continue;
    }
    if (c.source !== DRAWIO_NODE + e.from || c.target !== DRAWIO_NODE + e.to) rewired++;
    if (e.kind !== 'rel') continue;
    const [relId, idx] = [e.id.slice(0, e.id.lastIndexOf('#')), Number(e.id.slice(e.id.lastIndexOf('#') + 1))];
    const text = stripHtml(c.value);
    if (text !== (e.card?.text ?? '')) ops.push({ op: 'set_card', relationship: relId, end: idx, card: text });
    const r = relById.get(relId);
    const dashed = c.style.dashed === '1';
    if (r && dashed !== r.dashed && !dashedDone.has(relId)) {
      dashedDone.add(relId);
      ops.push({ op: 'set_flags', id: relId, dashed });
    }
  }
  const missing = d.nodes.filter((n) => !seen.has(n.id));
  if (missing.length) notes.push(`draw.io 里删掉了 ${missing.length} 个图形（${missing.slice(0, 6).map((n) => n.label).join('、')}${missing.length > 6 ? '……' : ''}），ER 图里保留；结构以源码为准，确实不要请用 exclude 并写原因`);
  if (unknownShapes) notes.push(`draw.io 里新加的 ${unknownShapes} 个图形没有导入（结构以源码为准）`);
  if (unknownEdges) notes.push(`draw.io 里新加的 ${unknownEdges} 条线没有导入；要加关系请用 add_relationship`);
  if (rewired) notes.push(`有 ${rewired} 条线在 draw.io 里改了端点，没有导入（端点由源码决定）`);
  return { ops, notes };
}
