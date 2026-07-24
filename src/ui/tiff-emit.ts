// SPDX-License-Identifier: MPL-2.0
/**
 * Print-ready DeviceCMYK TIFF — the raster counterpart to the CMYK PDF, for
 * placement in InDesign/Quark and for printers who want a flat file.
 *
 * The canvas is rasterised at true DPI like any other raster, then every pixel
 * goes through the same Separator the vector formats use, so a locked brand ink
 * lands on identical plate values whether it arrived as a path or as pixels.
 * Bytes are packed by the engine's generic `packTiff` (PhotometricInterpretation
 * 5 = Separated, 4 samples/pixel); the InkSet tag is left at its default of 1,
 * which already means CMYK.
 *
 * Deliberately untagged: no ICC profile is embedded. The conversion is a naïve
 * device separation, so attaching a real press profile would claim a colour
 * management that didn't happen — a file that lies to a RIP is worse than one
 * that says nothing. The chosen press condition is recorded in ImageDescription
 * as provenance instead: it names the intended viewing condition without
 * claiming the numbers were transformed for it.
 *
 * Transparency is flattened onto white — CMYK has no alpha and print stock is
 * white. Spot locks contribute only their process equivalent: a flat raster has
 * no per-plate channel for a named ink, so true Separation output stays a
 * PDF-only capability. That's a scope limit, not a bug.
 */
import { packTiff } from '@engine/tiff.ts';
import type { VectorEmitOpts } from '@engine/emf.ts';
import { cmykCondition } from '@engine/color.ts';
import { svgToCanvas } from './raster.ts';
import { DEFAULT_CONDITION, type Separator } from './cmyk.ts';

/** TIFF PhotometricInterpretation 5 — separated (CMYK) samples. */
const PHOTOMETRIC_SEPARATED = 5;

/** Rows converted between yields, so a large sheet can't freeze the panel. */
const YIELD_ROWS = 64;

export interface CmykTiffOpts {
  /** Press condition recorded as provenance (not applied — see the file note). */
  condition?: string;
  title?: string;
}

/**
 * RGBA (0–255, straight alpha) → packed CMYK bytes, 0 = no ink … 255 = full ink.
 *
 * One tight pass over the typed array with a small memo: artwork is overwhelmingly
 * flat colour, so caching by packed RGB turns millions of conversions into a few
 * hundred. Yields to the event loop periodically — a 300dpi A3 sheet is ~35M
 * pixels and would otherwise block the panel for seconds.
 */
async function rgbaToDeviceCmyk(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  sep: Separator,
): Promise<Uint8Array> {
  const out = new Uint8Array(width * height * 4);
  const memo = new Map<number, number>(); // packed RGB → packed CMYK
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3]!;
      // Flatten onto white stock before converting; an unpainted pixel is bare paper.
      let r = rgba[i]!;
      let g = rgba[i + 1]!;
      let b = rgba[i + 2]!;
      if (a !== 255) {
        const t = a / 255;
        const u = 255 * (1 - t);
        r = (r * t + u + 0.5) | 0;
        g = (g * t + u + 0.5) | 0;
        b = (b * t + u + 0.5) | 0;
      }
      const key = (r << 16) | (g << 8) | b;
      let packed = memo.get(key);
      if (packed === undefined) {
        const [c, m, yy, k] = sep.resolve(r / 255, g / 255, b / 255).cmyk;
        packed =
          (((c * 255 + 0.5) | 0) << 24) |
          (((m * 255 + 0.5) | 0) << 16) |
          (((yy * 255 + 0.5) | 0) << 8) |
          ((k * 255 + 0.5) | 0);
        memo.set(key, packed >>> 0);
      }
      out[i] = (packed >>> 24) & 255;
      out[i + 1] = (packed >>> 16) & 255;
      out[i + 2] = (packed >>> 8) & 255;
      out[i + 3] = packed & 255;
    }
    if (y % YIELD_ROWS === YIELD_ROWS - 1) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return out;
}

export async function emitCmykTiff(
  svgText: string,
  irW: number,
  irH: number,
  emitOpts: VectorEmitOpts,
  sep: Separator,
  opts: CmykTiffOpts = {},
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings: string[] = [];
  const canvas = await svgToCanvas(svgText, irW, irH, emitOpts, '#ffffff');
  const W = canvas.width;
  const H = canvas.height;
  const cx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = cx.getImageData(0, 0, W, H).data;

  const cmyk = await rgbaToDeviceCmyk(rgba, W, H, sep);

  if (sep.hasSpots) {
    warnings.push('Spot inks were written as their CMYK equivalent — a flat TIFF has no named plate. Use Print PDF for true separations.');
  }

  const cond = cmykCondition(opts.condition ?? DEFAULT_CONDITION);
  const bytes = packTiff(cmyk, {
    width: W,
    height: H,
    samplesPerPixel: 4,
    photometric: PHOTOMETRIC_SEPARATED,
    dpi: emitOpts.dpi ?? 300,
    meta: { software: 'Lolly Export for Penpot' },
    // Provenance, not a colour-management claim — see the file note.
    description:
      `${opts.title ? opts.title + ' — ' : ''}device CMYK, intended for ${cond.info}. ` +
      'Untagged: no ICC separation was applied.',
  });
  return { bytes, warnings };
}
