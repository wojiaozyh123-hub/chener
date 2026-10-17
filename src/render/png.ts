// PNG：用 resvg 把 SVG 栅格化。字体文件和量宽度时用的是同一份。

import { createRequire } from 'node:module';
import { defaultFamily, fontFilesFor } from '../text/fonts.js';

const require = createRequire(import.meta.url);
const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');

export const MAX_PNG_PIXELS = 120_000_000;

export function renderPng(svg: string, families: string[], scale = 2): Buffer {
  const m = /width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/.exec(svg);
  if (m) {
    const px = Number(m[1]) * Number(m[2]) * scale * scale;
    if (px > MAX_PNG_PIXELS) throw new Error(`图面 ${m[1]}×${m[2]} 放大 ${scale} 倍后太大，没有导出 PNG（核对报告里会写明画布异常）；可以先导出 SVG 看`);
  }
  const fontFiles = fontFilesFor([...families, defaultFamily()]);
  const r = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    background: '#ffffff',
    font: { fontFiles, loadSystemFonts: true, defaultFontFamily: families[0] ?? defaultFamily() },
  });
  return r.render().asPng();
}
