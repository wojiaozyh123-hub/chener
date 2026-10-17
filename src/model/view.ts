// 视图：位置、形状、字体。按节点 id 存，和模型分开，重新导入源码时保留。

import type { ShapeKind } from '../layout/shapes.js';

export interface KindStyle {
  size: number;
  bold: boolean;
}

export interface Style {
  fontFamily: string;
  entity: KindStyle;
  relationship: KindStyle;
  attribute: KindStyle;
  card: KindStyle;
  cardCase: 'upper' | 'lower'; // 1:N 还是 1:n
  lineWidth: number;
}

export interface NodeView {
  x?: number;
  y?: number;
  shape?: ShapeKind;
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  pinned?: boolean;
}

export interface View {
  style: Style;
  nodes: Record<string, NodeView>;
}

export function defaultStyle(fontFamily: string): Style {
  return {
    fontFamily,
    entity: { size: 16, bold: true },
    relationship: { size: 15, bold: true },
    attribute: { size: 13, bold: false },
    card: { size: 14, bold: false },
    cardCase: 'upper',
    lineWidth: 1.3,
  };
}
