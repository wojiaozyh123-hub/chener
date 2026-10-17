// SVG：黑线白底，矩形/菱形/椭圆，主键下划线，基数标签在线中间。

import type { Diagram, DNode } from '../layout/diagram.js';
import { DOUBLE_GAP, baseShape, isDouble } from '../layout/shapes.js';
import type { Style } from '../model/view.js';

export const PAD = 32;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fontStack(family: string): string {
  const list = [family, 'Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Noto Sans CJK SC', 'sans-serif'];
  return [...new Set(list)].map((f) => (f === 'sans-serif' ? f : `'${f.replace(/'/g, '')}'`)).join(', ');
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

function shapeSvg(n: DNode, x: number, y: number, sw: number): string {
  const b = baseShape(n.shape);
  const parts: string[] = [];
  const stroke = `fill="#ffffff" stroke="#111111" stroke-width="${sw}"`;
  const one = (w: number, h: number, dashed = false) => {
    const dash = dashed ? ' stroke-dasharray="5 3"' : '';
    if (b === 'rect') {
      const rx = n.shape === 'rounded-rect' ? ' rx="8"' : '';
      return `<rect x="${f1(x - w / 2)}" y="${f1(y - h / 2)}" width="${f1(w)}" height="${f1(h)}"${rx} ${stroke}${dash}/>`;
    }
    if (b === 'diamond') return `<polygon points="${f1(x)},${f1(y - h / 2)} ${f1(x + w / 2)},${f1(y)} ${f1(x)},${f1(y + h / 2)} ${f1(x - w / 2)},${f1(y)}" ${stroke}${dash}/>`;
    return `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(w / 2)}" ry="${f1(h / 2)}" ${stroke}${dash}/>`;
  };
  parts.push(one(n.w, n.h, n.shape === 'dashed-ellipse'));
  if (isDouble(n.shape)) {
    if (b === 'diamond') {
      const A = n.w / 2;
      const B = n.h / 2;
      const s = 1 - (DOUBLE_GAP * Math.hypot(A, B)) / (A * B);
      parts.push(one(n.w * s, n.h * s));
    } else parts.push(one(n.w - 2 * DOUBLE_GAP, n.h - 2 * DOUBLE_GAP));
  }
  return parts.join('');
}

export interface SvgOptions {
  /** 编辑器用：每个节点/连线/标签带 data-* 和点击区域，不加偏移、不画底色 */
  interactive?: boolean;
  /** 核对出问题的元素：id（节点 id、连线 id，标签用 card:连线id）→ 说明 */
  bad?: Map<string, string>;
  selected?: Set<string>;
}

function body(d: Diagram, style: Style, ox: number, oy: number, o: SvgOptions): string[] {
  const sw = style.lineWidth;
  const out: string[] = [];
  const ia = !!o.interactive;
  const bad = o.bad ?? new Map<string, string>();
  const tip = (id: string) => (bad.has(id) ? `<title>${esc(bad.get(id)!)}</title>` : '');
  out.push(`<g stroke="#111111" stroke-width="${sw}" stroke-linecap="round" fill="none">`);
  for (const e of d.edges) {
    const dash = e.dashed ? ' stroke-dasharray="6 4"' : '';
    const coords = `x1="${f1(e.a.x + ox)}" y1="${f1(e.a.y + oy)}" x2="${f1(e.b.x + ox)}" y2="${f1(e.b.y + oy)}"`;
    if (ia) {
      out.push(`<g class="edge${bad.has(e.id) ? ' bad' : ''}" data-edge="${esc(e.id)}" data-kind="${e.kind}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><line class="hit" ${coords} stroke="transparent" stroke-width="12"/><line class="ln" ${coords}${dash}/>${tip(e.id)}</g>`);
    } else out.push(`<line ${coords}${dash}/>`);
  }
  out.push('</g>');
  for (const n of d.nodes) {
    const x = n.x + ox;
    const y = n.y + oy;
    const base = y + (n.ascent - n.descent) / 2;
    const parts: string[] = [shapeSvg(n, x, y, n.kind === 'attribute' ? sw : sw + 0.2)];
    parts.push(`<text x="${f1(x)}" y="${f1(base)}" font-family="${esc(fontStack(n.family))}" font-size="${n.size}"${n.bold ? ' font-weight="bold"' : ''} text-anchor="middle" fill="#111111">${esc(n.label)}</text>`);
    if (n.underline !== 'none') {
      const uy = base + n.size * 0.14;
      const dash = n.underline === 'dashed' ? ' stroke-dasharray="4 2.5"' : '';
      parts.push(`<line x1="${f1(x - n.textW / 2)}" y1="${f1(uy)}" x2="${f1(x + n.textW / 2)}" y2="${f1(uy)}" stroke="#111111" stroke-width="1.1"${dash}/>`);
    }
    if (ia) {
      const cls = `node${bad.has(n.id) ? ' bad' : ''}${o.selected?.has(n.id) ? ' sel' : ''}`;
      out.push(`<g class="${cls}" data-node="${esc(n.id)}" data-kind="${n.kind}" data-cx="${f1(x)}" data-cy="${f1(y)}"${n.owner ? ` data-owner="${esc(n.owner)}"` : ''}>${parts.join('')}${tip(n.id)}</g>`);
    } else out.push(parts.join(''));
  }
  for (const e of d.edges) {
    const c = e.card;
    if (!c) continue;
    const x = c.x + ox;
    const y = c.y + oy;
    const inner = `<rect x="${f1(x - c.w / 2)}" y="${f1(y - c.h / 2)}" width="${f1(c.w)}" height="${f1(c.h)}" fill="#ffffff"/><text x="${f1(x)}" y="${f1(y + (c.ascent - c.descent) / 2)}" font-family="${esc(fontStack(c.family))}" font-size="${c.size}"${c.bold ? ' font-weight="bold"' : ''} text-anchor="middle" fill="#111111">${esc(c.text)}</text>`;
    if (ia) {
      const id = `card:${e.id}`;
      out.push(`<g class="card${bad.has(id) ? ' bad' : ''}" data-card="${esc(e.id)}">${inner}${tip(id)}</g>`);
    } else out.push(inner);
  }
  return out;
}

/** 编辑器画布内容（不含外层 <svg>），坐标就是项目里的坐标。 */
export function renderInteractive(d: Diagram, style: Style, o: SvgOptions = {}): string {
  return body(d, style, 0, 0, { ...o, interactive: true }).join('');
}

export function renderSvg(d: Diagram, style: Style): string {
  const { minX, minY, maxX, maxY } = d.bounds;
  const W = Math.ceil(maxX - minX + PAD * 2);
  const H = Math.ceil(maxY - minY + PAD * 2);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`,
    ...body(d, style, PAD - minX, PAD - minY, {}),
    '</svg>',
  ].join('\n');
}
