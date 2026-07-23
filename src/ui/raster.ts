// SPDX-License-Identifier: MPL-2.0
/**
 * SVG → raster bytes at true DPI, with the Lolly shell's canvas-stage layers:
 * HDR PQ boost (Rec.2100, engine hdr.ts) first, then the Imprint invisible
 * watermark — same order as the web shell. PNG gets pHYs + (for HDR) a cICP
 * chunk and Rec2100-PQ ICC; JPEG gets a JFIF density patch + (for HDR) the PQ
 * ICC. WebP is deliberately not offered HDR (8-bit, no working HDR decode
 * path — a PQ WebP just looks dark).
 */
import { insertPngPhys, patchJpegDpi, insertPngCicp, insertPngIcc, insertJpegIcc } from '@bridge/export-image-meta.ts';
import { parseDimension, toPixels } from '@engine/units.ts';
import { hdrBoostToPQ, HDR_PQ_CICP, type HdrBoostOptions } from '@engine/hdr.ts';
import { pqBt2020IccProfile } from '@engine/color.ts';
import { embedWatermark, canCarryWatermark } from '@engine/pixel-watermark.ts';
import type { VectorEmitOpts } from '@engine/emf.ts';

export type RasterFormat = 'png' | 'jpeg' | 'webp';

/** The author dials, 0–100 except peakNits — mirrors the web shell's HDR card. */
export interface HdrOpts {
  enabled: boolean;
  peakNits: number;   // 400–2000
  reach: number;      // 0–100 → OKLab-lightness knee
  lift: number;       // 0–100 → boostFloor
  richness: number;   // 0–100 → re-saturation
  /** Colours to boost toward peak (frame palette); white is always included. */
  targets: string[];
}

export const HDR_DIAL_DEFAULTS = { peakNits: 1000, reach: 45, lift: 0, richness: 40 };

/** Map the 0–100 dials onto engine hdrBoostToPQ knobs (same as the web shell). */
function hdrTune(hdr: HdrOpts): Partial<HdrBoostOptions> {
  const r = Math.min(1, Math.max(0, hdr.reach / 100));
  const center = 0.65 - 0.45 * r; // r=0 → brights only; r=1 → almost everything
  return {
    peakNits: hdr.peakNits,
    kneeLo: Math.max(0, center - 0.12),
    kneeHi: Math.min(1, center + 0.12),
    boostFloor: Math.min(1, Math.max(0, hdr.lift / 100)),
    richness: Math.min(1, Math.max(0, hdr.richness / 100)),
  };
}

const MIME: Record<RasterFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function targetPixels(irW: number, irH: number, opts: VectorEmitOpts): { w: number; h: number } {
  const dpi = opts.dpi ?? 300;
  // Stringify: parseDimension treats bare numbers as px, ignoring defaultUnit.
  const w = parseDimension(String(opts.width ?? irW), opts.unit ?? 'px');
  const h = parseDimension(String(opts.height ?? irH), opts.unit ?? 'px');
  if (w && h && w.unit !== 'px') {
    return { w: Math.round(toPixels(w, dpi)), h: Math.round(toPixels(h, dpi)) };
  }
  return { w: Math.round(w?.value ?? irW), h: Math.round(h?.value ?? irH) };
}

export async function rasterizeSvg(
  svgText: string,
  irW: number,
  irH: number,
  format: RasterFormat,
  opts: VectorEmitOpts = {},
  hdr?: HdrOpts,
  imprint?: boolean,
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings: string[] = [];
  const { w, h } = targetPixels(irW, irH, opts);
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    if (!cx) throw new Error('Canvas 2D unavailable');
    if (format === 'jpeg') {
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, w, h);
    }
    cx.drawImage(img, 0, 0, w, h);

    const hdrOn = Boolean(hdr?.enabled) && format !== 'webp';
    if (hdrOn || imprint) {
      const id = cx.getImageData(0, 0, w, h);
      if (hdrOn) hdrBoostToPQ(id.data, { targets: hdr!.targets, ...hdrTune(hdr!) });
      if (imprint) {
        if (canCarryWatermark(w, h)) {
          const marked = embedWatermark(id.data, { width: w, height: h });
          id.data.set(marked);
        } else {
          warnings.push('Image too small to carry the Imprint watermark.');
        }
      }
      cx.putImageData(id, 0, 0);
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error(`${format} encode failed`))),
        MIME[format],
        format === 'png' ? undefined : 0.92,
      );
    });
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());

    const dpi = opts.dpi ?? 300;
    if (format === 'png') {
      bytes = insertPngPhys(bytes, dpi) ?? bytes;
      if (hdrOn) {
        bytes = insertPngCicp(bytes, HDR_PQ_CICP);
        bytes = await insertPngIcc(bytes, pqBt2020IccProfile(), 'Rec2100 PQ');
      }
    }
    if (format === 'jpeg') {
      bytes = patchJpegDpi(bytes, dpi);
      if (hdrOn) bytes = insertJpegIcc(bytes, pqBt2020IccProfile());
    }
    return { bytes, warnings };
  } finally {
    URL.revokeObjectURL(url);
  }
}
