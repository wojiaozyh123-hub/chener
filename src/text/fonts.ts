// 字体：按字体名找到本机的字体文件，直接读字体文件量文字宽度。
// 命令行、MCP、以后的编辑器都走这一套，所以同一份项目文件在哪里排出来都一样宽。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fontkit from 'fontkit';

interface KnownFamily {
  family: string;
  aliases: string[];
  regular: string[];
  bold: string[];
}

const KNOWN: KnownFamily[] = [
  { family: 'Microsoft YaHei', aliases: ['微软雅黑', 'msyh', 'yahei', 'Microsoft YaHei UI'], regular: ['msyh.ttc', 'msyh.ttf'], bold: ['msyhbd.ttc', 'msyhbd.ttf'] },
  { family: 'SimHei', aliases: ['黑体'], regular: ['simhei.ttf'], bold: [] },
  { family: 'SimSun', aliases: ['宋体', 'NSimSun', '新宋体'], regular: ['simsun.ttc', 'simsun.ttf'], bold: [] },
  { family: 'KaiTi', aliases: ['楷体'], regular: ['simkai.ttf'], bold: [] },
  { family: 'FangSong', aliases: ['仿宋'], regular: ['simfang.ttf'], bold: [] },
  { family: 'DengXian', aliases: ['等线'], regular: ['Deng.ttf'], bold: ['Dengb.ttf'] },
  { family: 'Arial', aliases: [], regular: ['arial.ttf', 'Arial.ttf'], bold: ['arialbd.ttf', 'Arial Bold.ttf'] },
  { family: 'Times New Roman', aliases: [], regular: ['times.ttf', 'Times New Roman.ttf'], bold: ['timesbd.ttf', 'Times New Roman Bold.ttf'] },
  { family: 'PingFang SC', aliases: ['苹方'], regular: ['PingFang.ttc'], bold: [] },
  { family: 'Hiragino Sans GB', aliases: ['冬青黑体'], regular: ['Hiragino Sans GB.ttc'], bold: [] },
  { family: 'Heiti SC', aliases: ['STHeiti', '黑体-简'], regular: ['STHeiti Medium.ttc', 'STHeiti Light.ttc'], bold: [] },
  { family: 'Noto Sans CJK SC', aliases: ['Noto Sans SC'], regular: ['NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular.otf', 'NotoSansSC-Regular.otf'], bold: ['NotoSansCJK-Bold.ttc', 'NotoSansCJKsc-Bold.otf', 'NotoSansSC-Bold.otf'] },
  { family: 'Source Han Sans SC', aliases: ['思源黑体'], regular: ['SourceHanSansSC-Regular.otf', 'SourceHanSans-Regular.ttc'], bold: ['SourceHanSansSC-Bold.otf', 'SourceHanSans-Bold.ttc'] },
  { family: 'WenQuanYi Micro Hei', aliases: ['文泉驿微米黑'], regular: ['wqy-microhei.ttc'], bold: [] },
];

const DEFAULT_ORDER = ['Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', 'SimHei'];

function fontDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const win = process.env.WINDIR ?? 'C:\\Windows';
    return [path.join(win, 'Fonts'), path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local', 'share', 'fonts')];
}

let fileIndex: Map<string, string> | null = null; // 小写文件名 → 完整路径

function indexFiles(): Map<string, string> {
  if (fileIndex) return fileIndex;
  fileIndex = new Map();
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      if (/\.(ttf|ttc|otf|otc)$/i.test(n)) {
        if (!fileIndex!.has(n.toLowerCase())) fileIndex!.set(n.toLowerCase(), p);
      } else if (depth < 3) {
        try {
          if (fs.statSync(p).isDirectory()) walk(p, depth + 1);
        } catch {
          // 无权限的目录跳过
        }
      }
    }
  };
  for (const d of fontDirs()) walk(d, 0);
  return fileIndex;
}

type FkFont = fontkit.Font;

export interface FontFace {
  file: string;
  font: FkFont;
  family: string;
  postscriptName: string;
}

export interface ResolvedFont {
  requested: string;
  family: string; // 实际用的字体族名
  regular: FontFace | null;
  bold: FontFace | null;
  found: boolean;
}

function openFace(file: string, wantFamily: string, wantBold: boolean): FontFace | null {
  let f: FkFont | fontkit.FontCollection;
  try {
    f = fontkit.openSync(file);
  } catch {
    return null;
  }
  const faces: FkFont[] = 'fonts' in f ? f.fonts : [f];
  const fam = wantFamily.toLowerCase();
  const score = (x: FkFont) => {
    let s = 0;
    if (x.familyName?.toLowerCase() === fam) s += 4;
    else if (x.familyName?.toLowerCase().startsWith(fam)) s += 2;
    const bold = /bold|heavy|black|semibold|demibold/i.test(`${x.subfamilyName} ${x.postscriptName}`);
    if (bold === wantBold) s += 1;
    if (/\bUI\b/.test(x.familyName ?? '')) s -= 1;
    return s;
  };
  const best = [...faces].sort((a, b) => score(b) - score(a))[0];
  if (!best) return null;
  return { file, font: best, family: best.familyName, postscriptName: best.postscriptName };
}

const resolved = new Map<string, ResolvedFont>();
let scannedFamilies: Map<string, { regular?: string; bold?: string }> | null = null;

function scanAllFamilies(): Map<string, { regular?: string; bold?: string }> {
  if (scannedFamilies) return scannedFamilies;
  scannedFamilies = new Map();
  for (const file of indexFiles().values()) {
    let f: FkFont | fontkit.FontCollection;
    try {
      f = fontkit.openSync(file);
    } catch {
      continue;
    }
    const faces: FkFont[] = 'fonts' in f ? f.fonts : [f];
    for (const x of faces) {
      const key = (x.familyName ?? '').toLowerCase();
      if (!key) continue;
      const e = scannedFamilies.get(key) ?? {};
      const bold = /bold/i.test(`${x.subfamilyName} ${x.postscriptName}`);
      if (bold) e.bold ??= file;
      else e.regular ??= file;
      scannedFamilies.set(key, e);
    }
  }
  return scannedFamilies;
}

/** 按名字（中英文别名都行）找字体。找不到 found=false。 */
export function resolveFont(name: string): ResolvedFont {
  const key = name.trim().toLowerCase();
  const hit = resolved.get(key);
  if (hit) return hit;
  const idx = indexFiles();
  const known = KNOWN.find((k) => k.family.toLowerCase() === key || k.aliases.some((a) => a.toLowerCase() === key));
  let regular: FontFace | null = null;
  let bold: FontFace | null = null;
  if (known) {
    for (const fn of known.regular) {
      const p = idx.get(fn.toLowerCase());
      if (p && (regular = openFace(p, known.family, false))) break;
    }
    for (const fn of known.bold) {
      const p = idx.get(fn.toLowerCase());
      if (p && (bold = openFace(p, known.family, true))) break;
    }
  }
  if (!regular) {
    const fam = scanAllFamilies().get(key);
    if (fam?.regular) regular = openFace(fam.regular, name, false);
    if (fam?.bold) bold = openFace(fam.bold, name, true);
  }
  const r: ResolvedFont = { requested: name, family: known?.family ?? regular?.family ?? name, regular, bold, found: !!regular };
  resolved.set(key, r);
  return r;
}

let defaultCache: string | null = null;

/** 本机默认中文字体：Windows 用微软雅黑。 */
export function defaultFamily(): string {
  if (defaultCache) return defaultCache;
  for (const f of DEFAULT_ORDER) if (resolveFont(f).found) return (defaultCache = f);
  return (defaultCache = 'Microsoft YaHei');
}

export interface TextMetrics {
  width: number;
  ascent: number; // 基线以上
  descent: number; // 基线以下（正数）
  estimated: boolean; // 没找到字体，宽度是估算的
}

const measureCache = new Map<string, TextMetrics>();

/** 文字宽度。粗体有粗体字面就用粗体字面量，没有就按合成粗体加一点宽。 */
export function measureText(text: string, family: string, size: number, bold: boolean): TextMetrics {
  const key = `${family}|${size}|${bold ? 1 : 0}|${text}`;
  const c = measureCache.get(key);
  if (c) return c;
  const rf = resolveFont(family);
  const face = (bold ? rf.bold ?? rf.regular : rf.regular)?.font;
  let m: TextMetrics;
  if (!face) {
    let w = 0;
    for (const ch of text) w += /[\u2e80-\uffff]/.test(ch) ? size : /[A-Z0-9]/.test(ch) ? size * 0.62 : size * 0.52;
    m = { width: w * (bold ? 1.04 : 1), ascent: size * 0.88, descent: size * 0.22, estimated: true };
  } else {
    const scale = size / face.unitsPerEm;
    const run = face.layout(text);
    let w = run.advanceWidth * scale;
    // 字体里没有的字（id 0）按 1em 补
    for (const g of run.glyphs) if (g.id === 0) w += size - g.advanceWidth * scale;
    if (bold && !rf.bold) w += [...text].length * size * 0.04;
    m = { width: w, ascent: (face.ascent / face.unitsPerEm) * size, descent: (Math.abs(face.descent) / face.unitsPerEm) * size, estimated: false };
  }
  measureCache.set(key, m);
  return m;
}

/** 渲染 PNG 时要交给渲染器的字体文件。 */
export function fontFilesFor(families: string[]): string[] {
  const out = new Set<string>();
  for (const f of families) {
    const r = resolveFont(f);
    if (r.regular) out.add(r.regular.file);
    if (r.bold) out.add(r.bold.file);
  }
  return [...out];
}
