// 编辑器主进程、后台线程、页面之间传的数据。

import type { ShapeKind, NodeKind } from '../layout/shapes.js';
import type { Style } from '../model/view.js';

export interface NodeMeta {
  id: string;
  kind: NodeKind;
  label: string;
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  family: string;
  size: number;
  bold: boolean;
  owner?: string;
  pinned: boolean;
}

export interface EdgeMeta {
  id: string;
  kind: 'rel' | 'attr';
  from: string;
  to: string;
  dashed: boolean;
  card: { text: string; x: number; y: number } | null;
  mid: { x: number; y: number };
}

export interface Payload {
  file: string;
  title: string;
  svg: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  nodes: NodeMeta[];
  edges: EdgeMeta[];
  errors: number;
  style: Style;
}
