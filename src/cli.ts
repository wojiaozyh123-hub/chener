#!/usr/bin/env node
// chener 命令行。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { applyOpsToProject, defaultExportPath, evaluate, exportAll, generate, loadProject, relayout, saveProject, type ExportPaths, type State } from './project.js';
import { summaryText } from './summary.js';
import { defaultFamily, resolveFont } from './text/fonts.js';
import type { Op } from './model/ops.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

interface ExportFlags {
  png?: string | boolean;
  svg?: string | boolean;
  drawio?: string | boolean;
  scale?: string;
  json?: boolean;
}

function exportPaths(project: string, o: ExportFlags): ExportPaths {
  const pick = (v: string | boolean | undefined, ext: string) => (v === undefined || v === false ? undefined : v === true ? defaultExportPath(project, ext) : v);
  return { png: pick(o.png, '.png'), svg: pick(o.svg, '.svg'), drawio: pick(o.drawio, '.drawio'), scale: o.scale ? Number(o.scale) : undefined };
}

function finish(st: State, o: ExportFlags, save = true): void {
  if (save) saveProject(st);
  const written = [...(save ? [path.relative(process.cwd(), st.file) || st.file] : []), ...exportAll(st, exportPaths(st.file, o)).map((p) => path.relative(process.cwd(), p) || p)];
  if (o.json) {
    process.stdout.write(JSON.stringify({ ok: st.report.ok, report: st.report, pending: st.pending, written }, null, 2) + '\n');
  } else {
    process.stdout.write(summaryText(st, { written }) + '\n');
  }
  process.exitCode = st.report.ok ? 0 : 1;
}

function defaultProjectName(inputs: string[]): string {
  const first = inputs[0] ?? 'er';
  const base = path.basename(first.replace(/[\\/]+$/, '')).replace(/\.(sql|ddl|py)$/i, '') || 'er';
  return `${base}.er.json`;
}

const program = new Command();
program.name('chener').description('从 SQL 建表语句 / SQLAlchemy 源码生成 Chen 记法 ER 图').version(pkg.version);

program
  .command('gen')
  .description('读源码生成 ER 图（项目文件已存在时保留之前的决定，重新排布）')
  .argument('[inputs...]', '.sql / .py 文件或文件夹；不写就用项目文件里记的输入')
  .option('-o, --out <project>', '项目文件，默认 <第一个输入名>.er.json')
  .option('--png [file]', '导出 PNG')
  .option('--svg [file]', '导出 SVG')
  .option('--drawio [file]', '导出 draw.io 文件')
  .option('--scale <n>', 'PNG 放大倍数，默认 2')
  .option('--font <family>', '字体，例如 "Microsoft YaHei"、"SimHei"、"宋体"')
  .option('--json', '输出 JSON')
  .action(async (inputs: string[], o: ExportFlags & { out?: string; font?: string }) => {
    let out = o.out ?? defaultProjectName(inputs);
    let ins = inputs;
    if (!ins.length) {
      if (!fs.existsSync(out)) throw new Error('没有给输入文件，也没有找到项目文件；用法：chener gen 建表.sql');
      const p = loadProject(path.resolve(out));
      ins = p.inputs.map((i) => path.resolve(path.dirname(path.resolve(out)), i));
    }
    out = path.resolve(out);
    const st = await generate(ins, out, { font: o.font });
    finish(st, o);
  });

program
  .command('check')
  .description('核对项目文件：交叉、重叠、压线、漏列、证据')
  .argument('<project>')
  .option('--json', '输出 JSON')
  .action((file: string, o: ExportFlags) => {
    const abs = path.resolve(file);
    finish(evaluate(abs, loadProject(abs)), o, false);
  });

program
  .command('layout')
  .description('重新排布全部节点')
  .argument('<project>')
  .option('--png [file]', '导出 PNG')
  .option('--svg [file]', '导出 SVG')
  .option('--drawio [file]', '导出 draw.io 文件')
  .option('--scale <n>', 'PNG 放大倍数')
  .option('--json', '输出 JSON')
  .action((file: string, o: ExportFlags) => {
    const abs = path.resolve(file);
    finish(relayout(abs, loadProject(abs)), o);
  });

program
  .command('render')
  .description('按当前位置导出图片 / draw.io（不重新排布）')
  .argument('<project>')
  .option('--png [file]', '导出 PNG')
  .option('--svg [file]', '导出 SVG')
  .option('--drawio [file]', '导出 draw.io 文件')
  .option('--scale <n>', 'PNG 放大倍数')
  .option('--json', '输出 JSON')
  .action((file: string, o: ExportFlags) => {
    const abs = path.resolve(file);
    const st = evaluate(abs, loadProject(abs));
    if (o.png === undefined && o.svg === undefined && o.drawio === undefined) o.png = true;
    finish(st, o, false);
  });

program
  .command('apply')
  .description('应用一组修改操作（JSON 数组）；全部合法才写入')
  .argument('<project>')
  .argument('<ops>', '操作 JSON 文件，或直接写 JSON 字符串')
  .option('--no-relayout', '不重新排布')
  .option('--png [file]', '导出 PNG')
  .option('--svg [file]', '导出 SVG')
  .option('--drawio [file]', '导出 draw.io 文件')
  .option('--scale <n>', 'PNG 放大倍数')
  .option('--json', '输出 JSON')
  .action((file: string, opsArg: string, o: ExportFlags & { relayout?: boolean }) => {
    const text = fs.existsSync(opsArg) ? fs.readFileSync(opsArg, 'utf8') : opsArg;
    const ops = JSON.parse(text) as Op[];
    const r = applyOpsToProject(file, Array.isArray(ops) ? ops : [ops], o.relayout === false ? false : undefined);
    if (!r.state) {
      process.stderr.write(`没有写入，操作有误：\n${r.errors.map((e) => `  ✗ ${e}`).join('\n')}\n`);
      process.exitCode = 2;
      return;
    }
    finish(r.state, o);
  });

program
  .command('ledger')
  .description('列出每张表、每一列落到了哪里，以及待确认项')
  .argument('<project>')
  .option('--json', '输出 JSON')
  .action((file: string, o: { json?: boolean }) => {
    const abs = path.resolve(file);
    const st = evaluate(abs, loadProject(abs));
    if (o.json) {
      process.stdout.write(JSON.stringify({ ledger: st.ledger, pending: st.pending }, null, 2) + '\n');
      return;
    }
    const L: string[] = [];
    for (const t of st.ledger.tables) {
      L.push(`${t.table}  →  ${t.role === 'entity' ? '实体' : t.role === 'relationship' ? '关系' : '排除'} ${t.target}（${t.reason}）`);
      for (const c of st.ledger.columns.filter((x) => x.table === t.table)) {
        const fate = c.fate === 'attribute' ? '属性' : c.fate === 'relationship' ? '关系' : '排除';
        L.push(`    ${c.column.padEnd(22)} ${fate}  ${c.fate === 'excluded' ? `原因：${c.target}` : c.target}${c.note ? `（${c.note}）` : ''}`);
      }
    }
    process.stdout.write(L.join('\n') + '\n');
  });

program
  .command('fonts')
  .description('看本机能用的字体')
  .argument('[families...]')
  .action((families: string[]) => {
    const list = families.length ? families : ['Microsoft YaHei', 'SimHei', 'SimSun', 'KaiTi', 'DengXian', 'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Noto Sans CJK SC'];
    process.stdout.write(`默认：${defaultFamily()}\n`);
    for (const f of list) {
      const r = resolveFont(f);
      process.stdout.write(`${r.found ? '✓' : '✗'} ${f}${r.found ? `  ${r.regular!.file}${r.bold ? `  粗体 ${r.bold.file}` : '  （没有粗体字面，粗体为合成）'}` : ''}\n`);
    }
  });

program
  .command('mcp')
  .description('以 MCP 服务方式运行（stdio），供 Claude Code 等 agent 调用')
  .action(async () => {
    const { runMcp } = await import('./mcp.js');
    await runMcp(pkg.version);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`出错：${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
