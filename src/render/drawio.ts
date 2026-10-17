// draw.io 文件：节点和连线都是 draw.io 自己的图形，可以在 draw.io（含 Windows 桌面版）里继续拖动、改字。
// 每个图形的 id 就是 chener 里的 id（n: 节点，e: 连线），改完可以用 import-drawio 读回项目。

import type { Diagram, DNode } from '../layout/diagram.js';
import { esc } from './svg.js';

function shapeStyle(n: DNode): string {
  const font = `fontFamily=${n.family};fontSize=${n.size};fontStyle=${(n.bold ? 1 : 0) + (n.underline === 'solid' ? 4 : 0)};`;
  const common = `whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#111111;fontColor=#111111;${font}`;
  switch (n.shape) {
    case 'rect':
      return `rounded=0;${common}`;
    case 'rounded-rect':
      return `rounded=1;${common}`;
    case 'double-rect':
      return `shape=ext;double=1;rounded=0;${common}`;
    case 'diamond':
      return `rhombus;${common}`;
    case 'double-diamond':
      return `rhombus;double=1;${common}`;
    case 'ellipse':
      return `ellipse;${common}`;
    case 'double-ellipse':
      return `ellipse;shape=doubleEllipse;${common}`;
    case 'dashed-ellipse':
      return `ellipse;dashed=1;${common}`;
  }
}

export const DRAWIO_NODE = 'n:';
export const DRAWIO_EDGE = 'e:';

export function renderDrawio(d: Diagram, title: string): string {
  const ids = new Map<string, string>();
  d.nodes.forEach((n) => ids.set(n.id, DRAWIO_NODE + n.id));
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  for (const n of d.nodes) {
    const value = n.underline === 'dashed' ? `<u style="text-decoration-style:dashed">${esc(n.label)}</u>` : esc(n.label);
    cells.push(
      `<mxCell id="${esc(ids.get(n.id)!)}" value="${esc(value)}" style="${esc(shapeStyle(n))}" vertex="1" parent="1"><mxGeometry x="${(n.x - n.w / 2).toFixed(1)}" y="${(n.y - n.h / 2).toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" as="geometry"/></mxCell>`,
    );
  }
  // 同一对节点之间的多条线（自反关系）加一个错开的拐点，否则在 draw.io 里会叠成一条
  const pairCount = new Map<string, number>();
  for (const e of d.edges) {
    const pair = [e.from, e.to].sort().join('|');
    const seen = pairCount.get(pair) ?? 0;
    pairCount.set(pair, seen + 1);
    const dashed = e.dashed ? 'dashed=1;' : '';
    const font = e.card ? `fontFamily=${e.card.family};fontSize=${e.card.size};fontStyle=${e.card.bold ? 1 : 0};labelBackgroundColor=#ffffff;` : '';
    let points = '';
    if (seen > 0 || d.edges.some((f) => f !== e && [f.from, f.to].sort().join('|') === pair)) {
      const mx = (e.a.x + e.b.x) / 2;
      const my = (e.a.y + e.b.y) / 2;
      points = `<Array as="points"><mxPoint x="${mx.toFixed(1)}" y="${my.toFixed(1)}"/></Array>`;
    }
    cells.push(
      `<mxCell id="${esc(DRAWIO_EDGE + e.id)}" value="${esc(e.card?.text ?? '')}" style="${esc(`endArrow=none;html=1;rounded=0;edgeStyle=none;strokeColor=#111111;fontColor=#111111;${dashed}${font}`)}" edge="1" parent="1" source="${esc(ids.get(e.from)!)}" target="${esc(ids.get(e.to)!)}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`,
    );
  }
  return `<mxfile host="chener"><diagram name="${esc(title)}" id="er"><mxGraphModel grid="0" page="0" background="#ffffff"><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>\n`;
}
