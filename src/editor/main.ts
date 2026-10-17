// 编辑器主进程：窗口、菜单、文件对话框、撤销历史、监视项目文件（agent 用 MCP 改了，画布跟着变）。

import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { SHAPES, type ShapeKind } from '../layout/shapes.js';
import type { Op } from '../model/ops.js';
import type { ProjectFile } from '../project.js';
import type { Payload } from './protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: '矩形',
  'double-rect': '双矩形（弱实体）',
  'rounded-rect': '圆角矩形',
  diamond: '菱形',
  'double-diamond': '双菱形（标识关系）',
  ellipse: '椭圆',
  'double-ellipse': '双椭圆（多值属性）',
  'dashed-ellipse': '虚线椭圆（派生属性）',
};

let win: BrowserWindow | null = null;

// ---- 后台线程 ----
const worker = new Worker(path.join(here, 'worker.js'));
let seq = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
worker.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.ok) w.resolve(m.result);
  else w.reject(new Error(m.error));
});
function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ id, cmd, args });
  });
}

// ---- 当前文档和撤销历史 ----
interface Doc {
  file: string;
  project: ProjectFile;
  hash: string;
  payload: Payload;
}
interface Reply {
  project: ProjectFile;
  payload: Payload;
  hash: string;
  notes?: string[];
  errors?: string[];
}
let doc: Doc | null = null;
let inferredOpen = false;
let undoStack: ProjectFile[] = [];
let redoStack: ProjectFile[] = [];
let busy = 0;

function send(ch: string, data?: unknown): void {
  win?.webContents.send(ch, data);
}

function setDoc(r: Reply, history: 'push' | 'keep' | 'reset'): void {
  if (history === 'push' && doc) {
    undoStack.push(doc.project);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }
  if (history === 'reset') {
    undoStack = [];
    redoStack = [];
  }
  const fileChanged = doc?.file !== r.payload.file;
  doc = { file: r.payload.file, project: r.project, hash: r.hash, payload: r.payload };
  if (fileChanged) watch(doc.file);
  win?.setTitle(`${r.payload.title} — chener`);
  if (!r.payload.inferred.length) inferredOpen = false;
  send('state', r.payload);
  send('command', { name: 'inferred', open: inferredOpen });
  buildMenu();
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy++;
  send('busy', true);
  try {
    return await fn();
  } catch (e) {
    dialog.showErrorBox('出错', e instanceof Error ? e.message : String(e));
    return undefined;
  } finally {
    busy--;
    send('busy', busy > 0);
  }
}

// ---- 监视项目文件：别处（agent、命令行）改了就重新读进来，可以撤销 ----
let watcher: fs.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
function watch(file: string): void {
  watcher?.close();
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    watcher = fs.watch(dir, (_ev, name) => {
      if (name && name.toString() !== base) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => void reloadIfChanged(file), 300);
    });
  } catch {
    watcher = null;
  }
}
async function reloadIfChanged(file: string): Promise<void> {
  if (!doc || doc.file !== file || busy) return;
  let hash: string;
  try {
    hash = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return;
  }
  if (hash === doc.hash) return;
  const r = await run(() => call<Reply>('open', { file }));
  if (r) setDoc(r, 'push');
}

// ---- 动作 ----
async function openProject(file?: string): Promise<void> {
  let f = file;
  if (!f) {
    const res = await dialog.showOpenDialog(win!, { title: '打开项目', filters: [{ name: 'chener 项目', extensions: ['json'] }], properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return;
    f = res.filePaths[0];
  }
  const r = await run(() => call<Reply>('open', { file: f }));
  if (r) setDoc(r, 'reset');
}

async function generateFrom(kind: 'files' | 'folder'): Promise<void> {
  const res = await dialog.showOpenDialog(win!, {
    title: kind === 'files' ? '选择建表脚本或模型文件' : '选择项目文件夹',
    filters: kind === 'files' ? [{ name: 'SQL / Python', extensions: ['sql', 'ddl', 'py'] }] : undefined,
    properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return;
  const first = res.filePaths[0];
  const base = path.basename(first).replace(/\.(sql|ddl|py)$/i, '');
  const saveTo = await dialog.showSaveDialog(win!, {
    title: '项目保存到',
    defaultPath: path.join(kind === 'files' ? path.dirname(first) : first, `${base}.er.json`),
    filters: [{ name: 'chener 项目', extensions: ['json'] }],
  });
  if (saveTo.canceled || !saveTo.filePath) return;
  const r = await run(() => call<Reply>('generate', { inputs: res.filePaths, file: saveTo.filePath }));
  if (r) setDoc(r, 'reset');
}

async function applyOps(ops: Op[], mode: 'none' | 'keep' = 'none'): Promise<{ errors?: string[] }> {
  if (!doc || !ops.length) return {};
  const d = doc;
  const r = await run(() => call<Reply>('apply', { file: d.file, project: d.project, ops, mode }));
  if (!r) return {};
  if (r.errors) {
    dialog.showMessageBox(win!, { type: 'warning', message: '没有改成', detail: r.errors.join('\n') });
    return { errors: r.errors };
  }
  setDoc(r, 'push');
  return {};
}

async function undo(): Promise<void> {
  if (!doc || !undoStack.length) return;
  const d = doc;
  const prev = undoStack.pop()!;
  const r = await run(() => call<Reply>('restore', { file: d.file, project: prev }));
  if (r) {
    redoStack.push(d.project);
    setDoc(r, 'keep');
  } else undoStack.push(prev);
}

async function redo(): Promise<void> {
  if (!doc || !redoStack.length) return;
  const d = doc;
  const next = redoStack.pop()!;
  const r = await run(() => call<Reply>('restore', { file: d.file, project: next }));
  if (r) {
    undoStack.push(d.project);
    setDoc(r, 'keep');
  } else redoStack.push(next);
}

async function layout(keep: boolean): Promise<void> {
  if (!doc) return;
  const d = doc;
  const r = await run(() => call<Reply>('layout', { file: d.file, project: d.project, keep }));
  if (r) setDoc(r, 'push');
}

async function regenerate(): Promise<void> {
  if (!doc) return;
  const d = doc;
  const r = await run(() => call<Reply>('regenerate', { file: d.file, project: d.project }));
  if (r) setDoc(r, 'push');
}

async function exportAs(kind: 'png' | 'svg' | 'drawio'): Promise<void> {
  if (!doc) return;
  const d = doc;
  const res = await dialog.showSaveDialog(win!, {
    title: `导出 ${kind === 'drawio' ? 'draw.io' : kind.toUpperCase()}`,
    defaultPath: d.file.replace(/\.er\.json$|\.json$/i, '') + `.${kind}`,
    filters: [{ name: kind, extensions: [kind] }],
  });
  if (res.canceled || !res.filePath) return;
  await run(() => call('export', { file: d.file, project: d.project, kind, out: res.filePath }));
}

async function importDrawio(): Promise<void> {
  if (!doc) return;
  const d = doc;
  const res = await dialog.showOpenDialog(win!, { title: '读回 draw.io 里的修改', filters: [{ name: 'draw.io', extensions: ['drawio', 'xml'] }], properties: ['openFile'] });
  if (res.canceled || !res.filePaths[0]) return;
  const r = await run(() => call<Reply>('importDrawio', { file: d.file, project: d.project, drawio: res.filePaths[0] }));
  if (!r) return;
  if (r.errors) {
    dialog.showMessageBox(win!, { type: 'warning', message: '没有读回', detail: r.errors.join('\n') });
    return;
  }
  setDoc(r, 'push');
  if (r.notes?.length) dialog.showMessageBox(win!, { type: 'info', message: '已读回 draw.io 的修改', detail: r.notes.join('\n') });
}

// ---- 菜单 ----
function buildMenu(): void {
  const has = !!doc;
  const tpl: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开项目…', accelerator: 'CmdOrCtrl+O', click: () => void openProject() },
        { label: '从源码文件生成…', accelerator: 'CmdOrCtrl+N', click: () => void generateFrom('files') },
        { label: '从项目文件夹生成…', click: () => void generateFrom('folder') },
        { label: '重新读取源码', accelerator: 'CmdOrCtrl+R', enabled: has, click: () => void regenerate() },
        { type: 'separator' },
        { label: '导出 PNG…', enabled: has, click: () => void exportAs('png') },
        { label: '导出 SVG…', enabled: has, click: () => void exportAs('svg') },
        { label: '导出 draw.io…', enabled: has, click: () => void exportAs('drawio') },
        { label: '读回 draw.io 里的修改…', enabled: has, click: () => void importDrawio() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', enabled: undoStack.length > 0, click: () => void undo() },
        { label: '重做', accelerator: process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y', enabled: redoStack.length > 0, click: () => void redo() },
        { type: 'separator' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', enabled: has, click: () => send('command', { name: 'selectAll' }) },
        { type: 'separator' },
        {
          label: '推断项清单',
          type: 'checkbox',
          checked: inferredOpen,
          accelerator: 'CmdOrCtrl+I',
          enabled: has && (inferredOpen || !!doc?.payload.inferred.length),
          click: () => toggleInferred(!inferredOpen),
        },
        { type: 'separator' },
        { label: '整理（保留拖过的位置）', accelerator: 'CmdOrCtrl+L', enabled: has, click: () => void layout(true) },
        { label: '全部重排', accelerator: 'CmdOrCtrl+Shift+L', enabled: has, click: () => void layout(false) },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '适应窗口', accelerator: 'CmdOrCtrl+0', enabled: has, click: () => send('command', { name: 'fit' }) },
        { label: '放大', accelerator: 'CmdOrCtrl+=', enabled: has, click: () => send('command', { name: 'zoom', factor: 1.25 }) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', enabled: has, click: () => send('command', { name: 'zoom', factor: 0.8 }) },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function toggleInferred(open: boolean): void {
  inferredOpen = open && !!doc?.payload.inferred.length;
  send('command', { name: 'inferred', open: inferredOpen });
  buildMenu();
}

function contextMenu(kind: string, id: string): void {
  if (!doc) return;
  const items: MenuItemConstructorOptions[] = [];
  if (kind === 'node') {
    const n = doc.payload.nodes.find((x) => x.id === id);
    if (!n) return;
    items.push({ label: '改名', click: () => send('command', { name: 'rename', id }) });
    items.push({ type: 'separator' });
    for (const s of SHAPES) items.push({ label: SHAPE_NAMES[s], type: 'radio', checked: n.shape === s, click: () => void applyOps([{ op: 'set_shape', id, shape: s }]) });
    items.push({ type: 'separator' });
    items.push({ label: '恢复默认形状', click: () => void applyOps([{ op: 'set_shape', id, shape: null }]) });
    items.push({ label: '恢复默认字体', click: () => void applyOps([{ op: 'reset_style', id, props: ['fontFamily', 'fontSize', 'bold'] }]) });
  } else if (kind === 'edge') {
    const e = doc.payload.edges.find((x) => x.id === id);
    if (!e || e.kind !== 'rel') return;
    items.push({ label: '改基数', click: () => send('command', { name: 'editCard', id }) });
    items.push({ label: e.dashed ? '改成实线' : '改成虚线（逻辑关联）', click: () => void applyOps([{ op: 'set_flags', id: e.from, dashed: !e.dashed }]) });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win! });
}

// ---- 页面调用 ----
ipcMain.handle('chener', async (_e, cmd: string, args: Record<string, unknown> = {}) => {
  switch (cmd) {
    case 'state':
      return doc?.payload ?? null;
    case 'open':
      return openProject();
    case 'generate':
      return generateFrom('files');
    case 'apply':
      return applyOps(args.ops as Op[]);
    case 'contextMenu':
      return contextMenu(args.kind as string, args.id as string);
    case 'fonts':
      return call<string[]>('fonts');
    case 'rendered':
      return onRendered();
    case 'inferredClosed':
      return toggleInferred(false);
    default:
      throw new Error(`不认识的命令 ${cmd}`);
  }
});

// 开发自查用：CHENER_SNAPSHOT=xxx.png 时，画完第一张就截图退出
let snapshotDone = false;
async function onRendered(): Promise<void> {
  const out = process.env.CHENER_SNAPSHOT;
  if (!out || snapshotDone || !win) return;
  snapshotDone = true;
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  app.quit();
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'chener',
    backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(here, '..', '..', 'editor', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  buildMenu();
  await win.loadFile(path.join(here, '..', '..', 'editor', 'index.html'));
  const arg = process.argv.slice(1).find((x) => /\.json$/i.test(x) && fs.existsSync(x));
  const fileArg = process.env.CHENER_OPEN ?? arg;
  if (fileArg) await openProject(path.resolve(fileArg));
  if (process.env.CHENER_SNAPSHOT_INFERRED) toggleInferred(true);
});

app.on('window-all-closed', () => {
  void worker.terminate();
  app.quit();
});
