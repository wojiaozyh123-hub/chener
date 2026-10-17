// 项目文件（.er.json）和整条流水线：读源码 → 转模型 → 布局 → 核对 → 导出。
// 命令行和 MCP 都只调这里，保证两边结果一样。

import fs from 'node:fs';
import path from 'node:path';
import { collectFacts, relPath, toPosix } from './facts/collect.js';
import type { FactSet, Issue } from './facts/types.js';
import { buildDiagram, type Diagram } from './layout/diagram.js';
import { layoutModel, type LayoutReport } from './layout/index.js';
import { checkEvidence, checkGeometry, checkLedger, summarize, type CheckReport } from './check/verify.js';
import { convert } from './model/convert.js';
import { applyOps, type Op } from './model/ops.js';
import { emptyDecisions, type Decisions, type Ledger, type Model, type Pending } from './model/types.js';
import { defaultStyle, type View } from './model/view.js';
import { renderDrawio } from './render/drawio.js';
import { renderPng } from './render/png.js';
import { renderSvg } from './render/svg.js';
import { defaultFamily, resolveFont } from './text/fonts.js';

export const FORMAT = 'chener/1';

export interface ProjectFile {
  format: typeof FORMAT;
  title: string;
  inputs: string[]; // 相对项目文件所在目录
  facts: FactSet;
  decisions: Decisions;
  view: View;
  // 以下是推导结果，方便人和 agent 直接读；每次保存都重新生成
  model?: Model;
  ledger?: Ledger;
  pending?: Pending[];
  report?: CheckReport;
}

export interface State {
  file: string; // 项目文件绝对路径
  dir: string;
  project: ProjectFile;
  model: Model;
  ledger: Ledger;
  pending: Pending[];
  issues: Issue[];
  diagram: Diagram;
  report: CheckReport;
  layout?: LayoutReport;
}

export function loadProject(file: string): ProjectFile {
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectFile;
  if (p.format !== FORMAT) throw new Error(`${file} 不是 chener 项目文件（format 应为 ${FORMAT}）`);
  p.decisions = { ...emptyDecisions(), ...p.decisions };
  return p;
}

export function saveProject(st: State): void {
  const out: ProjectFile = { ...st.project, model: st.model, ledger: st.ledger, pending: st.pending, report: st.report };
  fs.mkdirSync(st.dir, { recursive: true });
  fs.writeFileSync(st.file, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

/** 从项目文件推导一切并核对（不改位置）。 */
export function evaluate(file: string, project: ProjectFile, layout?: LayoutReport): State {
  const dir = path.dirname(file);
  const conv = convert(project.facts, project.decisions);
  const diagram = buildDiagram(conv.model, project.view);
  const geometry = checkGeometry(diagram);
  const issues: Issue[] = [...project.facts.issues, ...conv.issues, ...checkEvidence(conv.model, dir), ...checkLedger(project.facts, conv.ledger, conv.model)];
  const families = new Set(diagram.nodes.map((n) => n.family));
  for (const f of families) {
    if (!resolveFont(f).found) issues.push({ level: 'warning', code: 'font.missing', message: `本机没有字体“${f}”，文字宽度是估算的；换台机器看可能略有出入` });
  }
  if (layout && !layout.planar) {
    issues.push({ level: 'info', code: 'layout.nonplanar', message: `骨架（实体和关系）本身不是平面图，以下连线必然交叉：${layout.forcedCrossings.map((c) => `${c.relationship}—${c.entity}`).join('、')}` });
  }
  if (layout?.fanFailures.length) issues.push({ level: 'error', code: 'layout.fan', message: `这些节点的属性没能摆开：${layout.fanFailures.join('、')}` });
  const report = summarize(project.facts, conv.ledger, conv.model, geometry, issues);
  return { file, dir, project, model: conv.model, ledger: conv.ledger, pending: conv.pending, issues, diagram, report, layout };
}

/** 重新排布全部节点。 */
export function relayout(file: string, project: ProjectFile): State {
  const conv = convert(project.facts, project.decisions);
  const { view, report } = layoutModel(conv.model, project.view);
  project.view = view;
  return evaluate(file, project, report);
}

export interface GenerateOptions {
  font?: string;
  title?: string;
}

/** 读源码生成（或更新）项目。已有项目文件时保留决定、样式和形状/字体设置，重新排布。 */
export async function generate(inputs: string[], file: string, opts: GenerateOptions = {}): Promise<State> {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const old = fs.existsSync(abs) ? loadProject(abs) : null;
  const absInputs = inputs.map((i) => path.resolve(i));
  const facts = await collectFacts(absInputs, dir);
  const style = old?.view.style ?? defaultStyle(opts.font ?? defaultFamily());
  if (opts.font) style.fontFamily = opts.font;
  const keepNodes: View['nodes'] = {};
  for (const [id, nv] of Object.entries(old?.view.nodes ?? {})) {
    const { x: _x, y: _y, pinned: _p, ...rest } = nv;
    void _x;
    void _y;
    void _p;
    if (Object.keys(rest).length) keepNodes[id] = rest;
  }
  const project: ProjectFile = {
    format: FORMAT,
    title: opts.title ?? old?.title ?? path.basename(abs).replace(/\.er\.json$|\.json$/i, ''),
    inputs: absInputs.map((p) => relPath(p, dir)),
    facts,
    decisions: old?.decisions ?? emptyDecisions(),
    view: { style, nodes: keepNodes },
  };
  return relayout(abs, project);
}

/** 应用一批操作：全部成功才写入；结构性修改后重新排布（只有 move 时保持手工位置）。 */
export function applyOpsToProject(file: string, ops: Op[], relayoutAfter?: boolean): { state: State | null; errors: string[] } {
  const abs = path.resolve(file);
  const project = loadProject(abs);
  const conv = convert(project.facts, project.decisions);
  const decisions = structuredClone(project.decisions);
  const view = structuredClone(project.view);
  const r = applyOps(decisions, view, conv.model, ops);
  if (r.errors.length) return { state: null, errors: r.errors };
  project.decisions = decisions;
  project.view = view;
  const doLayout = relayoutAfter ?? (r.structural && !ops.some((o) => o.op === 'move'));
  return { state: doLayout ? relayout(abs, project) : evaluate(abs, project), errors: [] };
}

export interface ExportPaths {
  png?: string;
  svg?: string;
  drawio?: string;
  scale?: number;
}

export function exportAll(st: State, paths: ExportPaths): string[] {
  const written: string[] = [];
  const svg = renderSvg(st.diagram, st.project.view.style);
  if (paths.svg) {
    fs.writeFileSync(paths.svg, svg, 'utf8');
    written.push(paths.svg);
  }
  if (paths.png) {
    const fams = [...new Set(st.diagram.nodes.map((n) => n.family))];
    fs.writeFileSync(paths.png, renderPng(svg, fams, paths.scale ?? 2));
    written.push(paths.png);
  }
  if (paths.drawio) {
    fs.writeFileSync(paths.drawio, renderDrawio(st.diagram, st.project.title), 'utf8');
    written.push(paths.drawio);
  }
  return written;
}

export function defaultExportPath(projectFile: string, ext: string): string {
  return projectFile.replace(/\.er\.json$|\.json$/i, '') + ext;
}

export { toPosix };
