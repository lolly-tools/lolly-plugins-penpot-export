// SPDX-License-Identifier: MPL-2.0
/**
 * SVG bytes from Penpot → Lolly vector IR → the requested output format.
 *
 * The heavy lifting is the web shell's svgDomToIr walk (reused verbatim from
 * the sibling lolly checkout): it flattens the SVG DOM into filled/stroked
 * path prims + raster escape-hatch images, and outlines every <text> run to
 * real paths via the HarfBuzz WASM text bridge. Fonts resolve through the
 * bridge's @font-face discovery — we inject Penpot's generateFontFaces CSS
 * into this document before walking, so Penpot's own fonts vectorise.
 */
import { svgDomToIr } from '@bridge/svg-ir.ts';
import { createTextAPI } from '@bridge/text.ts';
import { emitEps } from '@engine/eps.ts';
import { emitDxf } from '@engine/dxf.ts';
import { emitEmf } from '@engine/emf.ts';
import type { VectorIr, VectorEmitOpts } from '@engine/emf.ts';
import type { HostV1 } from '@engine/bridge/host-v1.ts';
import { parseDimension, toCssLength } from '@engine/units.ts';
import { rgbToCmyk } from '@engine/color.ts';
import type { PaletteSwatch } from '@engine/print-marks.ts';
import { emitPrintPdf, type PrintPdfOpts } from './pdf-emit.ts';
import { rasterizeSvg, type RasterFormat, type HdrOpts } from './raster.ts';
import { applyProtection, extractSvgPalette, type ProtectOpts } from './protect.ts';

export type OutputFormat =
  | 'pdf'
  | 'pdf-screen'
  | 'svg'
  | 'eps'
  | 'emf'
  | 'dxf'
  | RasterFormat; // 'png' | 'jpeg' | 'webp'

export interface ConvertOpts {
  format: OutputFormat;
  /** @font-face CSS from penpot.generateFontFaces (SVG/raster passthrough). */
  fontCss?: string;
  /** Physical output size (VectorEmitOpts semantics: value in `unit`). */
  width?: number;
  height?: number;
  unit?: string;
  dpi?: number;
  /** Print-PDF-only knobs (ignored elsewhere). */
  pdf?: Omit<PrintPdfOpts, 'title'>;
  /** Content protection (C2PA, imprint, authorship). */
  protect?: ProtectOpts;
  /** HDR PQ boost for png/jpeg. */
  hdr?: Omit<HdrOpts, 'targets'>;
  title?: string;
}

/** Frame colours → PaletteSwatch[] for the print colour bars (rgb + cmyk 0–1). */
function paletteSwatches(hexes: string[]): PaletteSwatch[] {
  return hexes.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    return { rgb: [r, g, b] as [number, number, number], cmyk: rgbToCmyk(r, g, b), label: hex };
  });
}

export interface ConvertResult {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  /** Text runs the walk could not outline (missing/CORS-blocked fonts). */
  warnings: string[];
}

const textApi = createTextAPI();

/** Minimal host: svg-ir only reaches for host.text and host.log. The contract's
 *  log is a FUNCTION (level, msg, ctx), not a console-like object. */
const host = {
  text: textApi,
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: object) => {
    (console[level] ?? console.log)('[lolly-export]', msg, ctx ?? '');
  },
} as unknown as HostV1;

let fontStyleEl: HTMLStyleElement | null = null;

/** Make Penpot's @font-face rules discoverable by the bridge font registry. */
export function installFontCss(css: string): void {
  if (!fontStyleEl) {
    fontStyleEl = document.createElement('style');
    fontStyleEl.dataset.penpotFonts = '';
    document.head.appendChild(fontStyleEl);
  }
  if (fontStyleEl.textContent !== css) fontStyleEl.textContent = css;
}

const inlinedFontCache = new Map<string, string>();

/**
 * Rewrite every url() in @font-face CSS to a data: URI so the CSS keeps
 * working inside an <img>-loaded SVG (which cannot fetch external resources).
 * A URL that fails to fetch (CORS) stays as-is.
 */
export async function inlineFontCss(css: string): Promise<string> {
  const urls = [...new Set([...css.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/g)].map((m) => m[2]!))]
    .filter((u) => !u.startsWith('data:'));
  await Promise.all(
    urls.map(async (u) => {
      if (inlinedFontCache.has(u)) return;
      try {
        const res = await fetch(u, { mode: 'cors' });
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUri = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
        inlinedFontCache.set(u, dataUri);
      } catch {
        /* keep the original URL */
      }
    }),
  );
  return css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (whole, _q: string, u: string) => {
    const inlined = inlinedFontCache.get(u);
    return inlined ? `url(${inlined})` : whole;
  });
}

/** Embed a <style> block right after the opening <svg …> tag. */
function injectSvgStyle(svgText: string, css: string): string {
  if (!css.trim()) return svgText;
  return svgText.replace(/(<svg[^>]*>)/, `$1<style>${css.replace(/<\/style/gi, '')}</style>`);
}

/** Force physical width/height attributes onto the root <svg>. */
function setSvgSize(svgText: string, wAttr: string, hAttr: string): string {
  return svgText.replace(/(<svg[^>]*?)(\s*>)/, (_m, open: string, close: string) => {
    const cleaned = open.replace(/\s(width|height)="[^"]*"/g, '');
    return `${cleaned} width="${wAttr}" height="${hAttr}"${close}`;
  });
}

/** Pixel size of an SVG document from width/height attrs or the viewBox. */
function svgPxSize(svgText: string): { w: number; h: number } {
  const open = /<svg[^>]*>/.exec(svgText)?.[0] ?? '';
  const attr = (name: string): number => {
    const m = new RegExp(`\\s${name}="([0-9.]+)(px)?"`).exec(open);
    return m ? parseFloat(m[1]!) : NaN;
  };
  let w = attr('width');
  let h = attr('height');
  if (!(w > 0 && h > 0)) {
    const vb = /viewBox="([\d.\s,-]+)"/.exec(open)?.[1]?.trim().split(/[\s,]+/).map(Number);
    if (vb?.length === 4) [, , w, h] = vb as [number, number, number, number];
  }
  return { w: w > 0 ? w : 1024, h: h > 0 ? h : 1024 };
}

/** Parse + mount the SVG off-screen so viewBox/getComputedStyle behave. */
function mountSvg(svgText: string): { svg: SVGSVGElement; dispose: () => void } {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error(`Penpot returned unparseable SVG: ${parseError.textContent?.slice(0, 120)}`);
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;';
  holder.appendChild(svg);
  document.body.appendChild(holder);
  return { svg, dispose: () => holder.remove() };
}

export async function svgToIr(svgText: string, label: string): Promise<{ ir: VectorIr; warnings: string[] }> {
  const warnings: string[] = [];
  const { svg, dispose } = mountSvg(svgText);
  try {
    const walk = (root: SVGSVGElement) =>
      svgDomToIr(root, {
        host,
        getComputedStyle: (el: Element) => window.getComputedStyle(el),
        label,
      });
    try {
      const ir = await walk(svg);
      return { ir, warnings };
    } catch (e) {
      // The IR walk hard-fails when a <text> run can't be outlined (font
      // missing or CORS-blocked). Don't let that block the whole export:
      // retry without the text nodes and say so.
      if (!svg.querySelector('text')) throw e;
      for (const t of Array.from(svg.querySelectorAll('text'))) t.remove();
      const ir = await walk(svg);
      warnings.push('Text could not be converted to outlines (font unavailable) and was left out of this format.');
      return { ir, warnings };
    }
  } finally {
    dispose();
  }
}

export async function convert(svgText: string, opts: ConvertOpts): Promise<ConvertResult> {
  const emitOpts: VectorEmitOpts = {
    width: opts.width,
    height: opts.height,
    unit: opts.unit,
    dpi: opts.dpi,
  };

  const result = await render(svgText, opts, emitOpts);
  // Content protection runs on the finished bytes for every format that can
  // carry it (svg/png/jpg/webp/pdf); the imprint watermark already happened at
  // the canvas stage inside rasterizeSvg.
  if (opts.protect) {
    result.bytes = await applyProtection(result.bytes, result.ext, { ...opts.protect, title: opts.title }, result.warnings);
  }
  return result;
}

async function render(svgText: string, opts: ConvertOpts, emitOpts: VectorEmitOpts): Promise<ConvertResult> {
  // SVG and raster don't go through the vector-IR walk at all: they use
  // Penpot's own SVG, with the @font-face CSS inlined as data: URIs so text
  // keeps its real font even inside an <img>-loaded SVG (which cannot fetch
  // external resources).
  if (opts.format === 'svg' || opts.format === 'png' || opts.format === 'jpeg' || opts.format === 'webp') {
    const css = await inlineFontCss(opts.fontCss ?? '');
    const withFonts = injectSvgStyle(svgText, css);
    const { w: irW, h: irH } = svgPxSize(svgText);

    if (opts.format === 'svg') {
      let out = withFonts;
      if (opts.width != null && opts.height != null && opts.unit && opts.unit !== 'px') {
        const w = parseDimension(String(opts.width), opts.unit);
        const h = parseDimension(String(opts.height), opts.unit);
        if (w && h) out = setSvgSize(out, toCssLength(w), toCssLength(h));
      }
      return { bytes: new TextEncoder().encode(out), mime: 'image/svg+xml', ext: 'svg', warnings: [] };
    }

    const hdr: HdrOpts | undefined = opts.hdr?.enabled
      ? { ...opts.hdr, targets: extractSvgPalette(svgText) }
      : undefined;
    const { bytes, warnings } = await rasterizeSvg(
      withFonts, irW, irH, opts.format, emitOpts, hdr, opts.protect?.imprint ?? false,
    );
    return { bytes, warnings, ...RASTER_META[opts.format] };
  }

  const label = opts.format === 'pdf-screen' ? 'PDF' : opts.format.toUpperCase();
  const { ir, warnings } = await svgToIr(svgText, label);

  switch (opts.format) {
    case 'eps': {
      const text = emitEps(ir, emitOpts);
      return { bytes: new TextEncoder().encode(text), mime: 'application/postscript', ext: 'eps', warnings };
    }
    case 'dxf': {
      const { text, droppedImages } = emitDxf(ir, emitOpts);
      if (droppedImages > 0) warnings.push(`DXF has no raster support — ${droppedImages} image(s) dropped.`);
      return { bytes: new TextEncoder().encode(text), mime: 'application/dxf', ext: 'dxf', warnings };
    }
    case 'emf': {
      const bytes = emitEmf(ir, emitOpts);
      return { bytes, mime: 'image/emf', ext: 'emf', warnings };
    }
    case 'pdf': {
      // Frame colours ride into the colour bars as brand swatch pairs.
      const palette = paletteSwatches(extractSvgPalette(svgText));
      const bytes = await emitPrintPdf(ir, { ...(opts.pdf ?? {}), palette, title: opts.title, ...emitOpts });
      return { bytes, mime: 'application/pdf', ext: 'pdf', warnings };
    }
    case 'pdf-screen': {
      // Screen PDF: page = artwork, no bleed/marks/PDF-X — for sharing.
      const bytes = await emitPrintPdf(ir, { title: opts.title, ...emitOpts });
      return { bytes, mime: 'application/pdf', ext: 'pdf', warnings };
    }
  }
}

const RASTER_META: Record<RasterFormat, { mime: string; ext: string }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
};
