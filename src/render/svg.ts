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

export function renderSvg(d: Diagram, style: Style): string {
  const { minX, minY, maxX, maxY } = d.bounds;
  const W = Math.ceil(maxX - minX + PAD * 2);
  const H = Math.ceil(maxY - minY + PAD * 2);
  const ox = PAD - minX;
  const oy = PAD - minY;
  const sw = style.lineWidth;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<g stroke="#111111" stroke-width="${sw}" stroke-linecap="round" fill="none">`);
  for (const e of d.edges) {
    const dash = e.dashed ? ' stroke-dasharray="6 4"' : '';
    out.push(`<line x1="${f1(e.a.x + ox)}" y1="${f1(e.a.y + oy)}" x2="${f1(e.b.x + ox)}" y2="${f1(e.b.y + oy)}"${dash}/>`);
  }
  out.push('</g>');
  for (const n of d.nodes) out.push(shapeSvg(n, n.x + ox, n.y + oy, n.kind === 'attribute' ? sw : sw + 0.2));
  for (const n of d.nodes) {
    const x = n.x + ox;
    const base = n.y + oy + (n.ascent - n.descent) / 2;
    out.push(`<text x="${f1(x)}" y="${f1(base)}" font-family="${esc(fontStack(n.family))}" font-size="${n.size}"${n.bold ? ' font-weight="bold"' : ''} text-anchor="middle" fill="#111111">${esc(n.label)}</text>`);
    if (n.underline !== 'none') {
      const uy = base + n.size * 0.14;
      const dash = n.underline === 'dashed' ? ' stroke-dasharray="4 2.5"' : '';
      out.push(`<line x1="${f1(x - n.textW / 2)}" y1="${f1(uy)}" x2="${f1(x + n.textW / 2)}" y2="${f1(uy)}" stroke="#111111" stroke-width="1.1"${dash}/>`);
    }
  }
  for (const e of d.edges) {
    const c = e.card;
    if (!c) continue;
    const x = c.x + ox;
    const y = c.y + oy;
    out.push(`<rect x="${f1(x - c.w / 2)}" y="${f1(y - c.h / 2)}" width="${f1(c.w)}" height="${f1(c.h)}" fill="#ffffff"/>`);
    out.push(`<text x="${f1(x)}" y="${f1(y + (c.ascent - c.descent) / 2)}" font-family="${esc(fontStack(c.family))}" font-size="${c.size}"${c.bold ? ' font-weight="bold"' : ''} text-anchor="middle" fill="#111111">${esc(c.text)}</text>`);
  }
  out.push('</svg>');
  return out.join('\n');
}
