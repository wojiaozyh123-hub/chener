// 后台线程：读源码、排布、核对、导出都在这里做，界面不会卡住。每次改完都把项目写回文件。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { Op } from '../model/ops.js';
import { applyOpsInMemory, evaluate, exportAll, generate, importDrawio, loadProject, relayout, saveProject, type LayoutMode, type ProjectFile, type State } from '../project.js';
import { inferredItems } from '../model/inferred.js';
import { renderInteractive } from '../render/svg.js';
import { availableFamilies } from '../text/fonts.js';
import type { Payload } from './protocol.js';

function payload(st: State): Payload {
  // 核对出问题的元素，在画布上直接标红；鼠标停上去看原因
  const bad = new Map<string, string>();
  for (const g of st.report.geometry) {
    if (g.kind === 'label-overlap') {
      if (!bad.has(`card:${g.ids[0]}`)) bad.set(`card:${g.ids[0]}`, g.message);
      continue;
    }
    for (const id of g.ids) if (!bad.has(id)) bad.set(id, g.message);
  }
  for (const i of st.report.issues) if (i.level === 'error') for (const id of i.ids ?? []) if (!bad.has(id)) bad.set(id, i.message);
  const d = st.diagram;
  const relDashed = new Map(st.model.relationships.map((r) => [r.id, r.dashed] as const));
  return {
    file: st.file,
    title: st.project.title,
    svg: renderInteractive(d, st.project.view.style, { bad }),
    bounds: d.bounds,
    nodes: d.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, shape: n.shape, x: n.x, y: n.y, w: n.w, h: n.h, family: n.family, size: n.size, bold: n.bold, owner: n.owner, pinned: !!st.project.view.nodes[n.id]?.pinned })),
    edges: d.edges.map((e) => ({
      id: e.id,
      kind: e.kind,
      from: e.from,
      to: e.to,
      dashed: e.kind === 'rel' ? !!relDashed.get(e.from) : false,
      card: e.card ? { text: e.card.text, x: e.card.x, y: e.card.y } : null,
      mid: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 },
    })),
    errors: st.report.errors,
    style: st.project.view.style,
    inferred: inferredItems(st.project.facts, st.project.decisions, st.model, st.pending),
  };
}

function save(st: State): string {
  saveProject(st);
  return createHash('sha1').update(fs.readFileSync(st.file)).digest('hex');
}

interface Reply {
  project: ProjectFile;
  payload: Payload;
  hash: string;
  notes?: string[];
}

function done(st: State, extra: Partial<Reply> = {}): Reply {
  return { project: st.project, payload: payload(st), hash: save(st), ...extra };
}

type Args = Record<string, unknown>;

async function handle(cmd: string, a: Args): Promise<unknown> {
  const file = a.file as string;
  const project = a.project as ProjectFile;
  switch (cmd) {
    case 'open': {
      const p = loadProject(file);
      let st = evaluate(file, p);
      // 老文件或别处生成的文件里有节点没有位置：整理一次，把它们放上去
      if (st.diagram.nodes.some((n) => !n.placed)) {
        st = relayout(file, p, true);
        return done(st);
      }
      const hash = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
      return { project: st.project, payload: payload(st), hash };
    }
    case 'generate':
      return done(await generate(a.inputs as string[], file));
    case 'regenerate': {
      const dir = path.dirname(file);
      return done(await generate(project.inputs.map((i) => path.resolve(dir, i)), file));
    }
    case 'apply': {
      const r = applyOpsInMemory(file, project, a.ops as Op[], (a.mode as LayoutMode) ?? 'none');
      if (!r.state) return { errors: r.errors };
      return done(r.state);
    }
    case 'layout':
      return done(relayout(file, project, !!a.keep));
    case 'restore':
      return done(evaluate(file, project));
    case 'importDrawio': {
      const r = importDrawio(file, project, fs.readFileSync(a.drawio as string, 'utf8'));
      if (!r.state) return { errors: r.errors };
      return done(r.state, { notes: r.notes });
    }
    case 'export': {
      const st = evaluate(file, project);
      exportAll(st, { [a.kind as string]: a.out as string, scale: 2 });
      return { ok: true };
    }
    case 'fonts':
      return availableFamilies();
    default:
      throw new Error(`不认识的命令 ${cmd}`);
  }
}

parentPort!.on('message', async (m: { id: number; cmd: string; args: Args }) => {
  try {
    parentPort!.postMessage({ id: m.id, ok: true, result: await handle(m.cmd, m.args ?? {}) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
