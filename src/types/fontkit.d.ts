declare module 'fontkit' {
  export interface Glyph {
    id: number;
    advanceWidth: number;
  }
  export interface GlyphRun {
    advanceWidth: number;
    glyphs: Glyph[];
  }
  export interface Font {
    familyName: string;
    subfamilyName: string;
    postscriptName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    layout(text: string): GlyphRun;
  }
  export interface FontCollection {
    fonts: Font[];
  }
  export function openSync(path: string, postscriptName?: string): Font | FontCollection;
}
