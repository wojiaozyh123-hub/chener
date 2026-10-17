// MCP 服务（stdio）：给 Claude Code、Cursor 等 agent 调用。工具和命令行走同一条流水线。

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Op } from './model/ops.js';
import { SHAPES } from './layout/shapes.js';
import { applyOpsToProject, defaultExportPath, evaluate, exportAll, generate, loadProject, relayout, saveProject, type State } from './project.js';
import { renderPng } from './render/png.js';
import { renderSvg } from './render/svg.js';
import { summaryText } from './summary.js';

const INSTRUCTIONS = `chener 从 SQL 建表语句（MySQL / PostgreSQL / SQLite / SQL Server / Oracle）或 SQLAlchemy 模型生成 Chen 记法 ER 图：矩形是实体，菱形是关系，椭圆是属性，主键带下划线，线上标 1 / N / M。程序保证线不交叉、节点不重叠、每一列都有去处，并在 report 里如实报告。

用法：
1. generate_er：inputs 填 .sql / .py 文件或文件夹（尽量用绝对路径），project 填要写出的 .er.json。
2. 看返回的“待确认”，读项目源码后决定：
   - 没注释、用原名的：用 rename 起中文名（参照表名、代码里的用法）。
   - 用了默认名“拥有/关联”的关系：rename 成贴切的动词（生成、收藏、播放、发布……）。
   - 按列名推断的外键：确认无误就不用管；错了用 unlink_column（当普通属性）或 link_column（改目标表）。
   - 像外键但没连上的列：确实是外键就 link_column。
   - 按规则判定的表角色：两个外键的表默认判成 M:N 关系菱形；应当是实体时用 set_table_role。
3. apply_er_ops 一次提交多个操作，全部合法才写入，写入后自动重新排布并核对。
   - 库里没有列、但代码里确实存在的业务关系（例如管理员管理歌曲），用 add_relationship，并且必须附 evidence：file（相对项目文件所在目录或绝对路径）、line（行号）、text（该行里的一段原文）。程序会去文件里核对，对不上就报错。
   - 只有用户亲口说过的关系才写 assertedBy:"user"。不要编造关系或字段。
4. render_er 导出 PNG（会把图片一并返回给你看）、SVG 或 draw.io 文件。
check_er 没通过时，把问题原样告诉用户，不要说成已经完成。`;

const cardSchema = z.string().describe('基数文本：1、N、M，或自定义如 0..1');
const evidenceSchema = z.object({ file: z.string(), line: z.number().int().positive(), text: z.string().min(1) });

const opSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), id: z.string().describe('实体=表名；属性=表名.列名；关系=fk:表.列 / rel:关联表 / add:xxx'), label: z.string() }),
  z.object({ op: z.literal('set_card'), relationship: z.string(), end: z.union([z.number().int(), z.string()]).describe('端序号（从 0 起）或实体 id'), card: cardSchema }),
  z.object({ op: z.literal('set_table_role'), table: z.string(), role: z.enum(['entity', 'relationship']) }),
  z.object({ op: z.literal('link_column'), column: z.string().describe('表名.列名'), table: z.string().describe('目标表名') }),
  z.object({ op: z.literal('unlink_column'), column: z.string().describe('表名.列名') }),
  z.object({ op: z.literal('exclude'), id: z.string().describe('表名 或 表名.列名'), reason: z.string().min(1) }),
  z.object({ op: z.literal('include'), id: z.string() }),
  z.object({
    op: z.literal('add_relationship'),
    id: z.string().optional(),
    label: z.string(),
    ends: z.array(z.object({ entity: z.string(), card: cardSchema })).min(2),
    attributes: z.array(z.object({ label: z.string(), key: z.boolean().optional() })).optional(),
    dashed: z.boolean().optional().describe('虚线，表示逻辑关联'),
    identifying: z.boolean().optional(),
    evidence: z.array(evidenceSchema).optional(),
    assertedBy: z.literal('user').optional(),
  }),
  z.object({ op: z.literal('remove_relationship'), id: z.string() }),
  z.object({
    op: z.literal('set_flags'),
    id: z.string(),
    key: z.boolean().optional(),
    partialKey: z.boolean().optional(),
    multivalued: z.boolean().optional(),
    derived: z.boolean().optional(),
    weak: z.boolean().optional(),
    identifying: z.boolean().optional(),
    dashed: z.boolean().optional(),
  }),
  z.object({ op: z.literal('set_shape'), id: z.string(), shape: z.enum(SHAPES).nullable().describe('null 恢复默认形状') }),
  z.object({
    op: z.literal('set_style'),
    id: z.string().optional().describe('不填就是改全局'),
    kind: z.enum(['entity', 'relationship', 'attribute', 'card']).optional(),
    fontFamily: z.string().optional(),
    fontSize: z.number().positive().optional(),
    bold: z.boolean().optional(),
    cardCase: z.enum(['upper', 'lower']).optional(),
  }),
  z.object({ op: z.literal('move'), id: z.string(), x: z.number(), y: z.number() }),
]);

function textResult(text: string, extra: { type: 'image'; data: string; mimeType: string }[] = []) {
  return { content: [{ type: 'text' as const, text }, ...extra] };
}

function preview(st: State): { type: 'image'; data: string; mimeType: string } {
  const svg = renderSvg(st.diagram, st.project.view.style);
  const png = renderPng(svg, [...new Set(st.diagram.nodes.map((n) => n.family))], 1);
  return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
}

function guard<T>(fn: () => Promise<T> | T) {
  return Promise.resolve()
    .then(fn)
    .catch((e: unknown) => textResult(`出错：${e instanceof Error ? e.message : String(e)}`) as unknown as T);
}

export async function runMcp(version: string): Promise<void> {
  const server = new McpServer({ name: 'chener', version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'generate_er',
    {
      title: '从源码生成 ER 图',
      description: '读 .sql 建表脚本或 SQLAlchemy 模型（文件或文件夹），生成/更新 .er.json 项目并排布、核对。项目已存在时保留之前的改名等决定。',
      inputSchema: {
        inputs: z.array(z.string()).min(1).describe('.sql / .py 文件或文件夹路径'),
        project: z.string().describe('项目文件路径，如 D:/work/music.er.json'),
        font: z.string().optional().describe('字体，如 Microsoft YaHei / SimHei / 宋体'),
        png: z.boolean().optional().describe('同时导出 PNG 并返回图片，默认 true'),
      },
    },
    (a) =>
      guard(async () => {
        const st = await generate(a.inputs, path.resolve(a.project), { font: a.font });
        saveProject(st);
        const written = [st.file];
        const extra = [];
        if (a.png !== false) {
          written.push(...exportAll(st, { png: defaultExportPath(st.file, '.png') }));
          extra.push(preview(st));
        }
        return textResult(summaryText(st, { written, limit: 30 }), extra);
      }),
  );

  server.registerTool(
    'get_er',
    {
      title: '读取项目',
      description: '读取模型（实体/属性/关系的 id 和名字）、列清单、待确认项或核对报告。改图前先用它拿到准确的 id。',
      inputSchema: {
        project: z.string(),
        part: z.enum(['model', 'ledger', 'pending', 'report', 'all']).optional().describe('默认 model + pending'),
      },
    },
    (a) =>
      guard(() => {
        const abs = path.resolve(a.project);
        const st = evaluate(abs, loadProject(abs));
        const model = {
          entities: st.model.entities.map((e) => ({ id: e.id, label: e.label, weak: e.weak || undefined, attributes: e.attributes.map((x) => ({ id: x.id, label: x.label, key: x.key || undefined })) })),
          relationships: st.model.relationships.map((r) => ({ id: r.id, label: r.label, origin: r.origin, ends: r.ends, attributes: r.attributes.map((x) => ({ id: x.id, label: x.label })) })),
        };
        const part = a.part ?? 'default';
        const body =
          part === 'model' ? { model } : part === 'ledger' ? { ledger: st.ledger } : part === 'pending' ? { pending: st.pending } : part === 'report' ? { report: st.report } : part === 'all' ? { model, ledger: st.ledger, pending: st.pending, report: st.report } : { model, pending: st.pending };
        return textResult(JSON.stringify(body, null, 1));
      }),
  );

  server.registerTool(
    'apply_er_ops',
    {
      title: '修改 ER 图',
      description: '一次提交多个修改操作。全部合法才写入；结构性修改后自动重新排布并核对（只有 move 时保留手工位置）。',
      inputSchema: {
        project: z.string(),
        ops: z.array(opSchema).min(1),
        relayout: z.boolean().optional().describe('强制重新排布 / 不排布'),
        png: z.boolean().optional().describe('导出 PNG 并返回图片，默认 true'),
      },
    },
    (a) =>
      guard(() => {
        const r = applyOpsToProject(a.project, a.ops as Op[], a.relayout);
        if (!r.state) return textResult(`没有写入，操作有误：\n${r.errors.map((e) => `- ${e}`).join('\n')}`);
        saveProject(r.state);
        const written = [r.state.file];
        const extra = [];
        if (a.png !== false) {
          written.push(...exportAll(r.state, { png: defaultExportPath(r.state.file, '.png') }));
          extra.push(preview(r.state));
        }
        return textResult(summaryText(r.state, { written, limit: 30 }), extra);
      }),
  );

  server.registerTool(
    'layout_er',
    { title: '重新排布', description: '重新排布全部节点（会覆盖手工 move 的位置）。', inputSchema: { project: z.string() } },
    (a) =>
      guard(() => {
        const abs = path.resolve(a.project);
        const st = relayout(abs, loadProject(abs));
        saveProject(st);
        return textResult(summaryText(st, { written: [st.file], limit: 30 }), [preview(st)]);
      }),
  );

  server.registerTool(
    'check_er',
    { title: '核对', description: '核对交叉、重叠、线穿节点、标签压线、漏列、证据，返回逐条问题。', inputSchema: { project: z.string() } },
    (a) =>
      guard(() => {
        const abs = path.resolve(a.project);
        const st = evaluate(abs, loadProject(abs));
        return textResult(`${summaryText(st, { limit: 50 })}\n\n${JSON.stringify({ ok: st.report.ok, geometry: st.report.geometry }, null, 1)}`);
      }),
  );

  server.registerTool(
    'render_er',
    {
      title: '导出',
      description: '按当前位置导出 PNG / SVG / draw.io（不重新排布）。PNG 会一并返回图片。',
      inputSchema: {
        project: z.string(),
        format: z.enum(['png', 'svg', 'drawio']),
        out: z.string().optional().describe('输出路径，默认和项目文件同名'),
        scale: z.number().positive().optional().describe('PNG 放大倍数，默认 2'),
      },
    },
    (a) =>
      guard(() => {
        const abs = path.resolve(a.project);
        const st = evaluate(abs, loadProject(abs));
        const out = a.out ? path.resolve(a.out) : defaultExportPath(abs, `.${a.format}`);
        exportAll(st, { [a.format]: out, scale: a.scale });
        const ok = fs.existsSync(out);
        return textResult(`${ok ? '已写入' : '没有写成'}：${out}\n核对：${st.report.ok ? '通过' : `没通过，${st.report.errors} 处错误（用 check_er 看详情）`}`, a.format === 'png' ? [preview(st)] : []);
      }),
  );

  await server.connect(new StdioServerTransport());
}
