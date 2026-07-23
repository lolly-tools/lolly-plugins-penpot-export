// SPDX-License-Identifier: MPL-2.0
/**
 * Content protection — the same layers the Lolly web shell applies on export:
 *
 *  1. Authorship metadata in each format's native slot (PNG iTXt, JPEG EXIF,
 *     SVG <metadata>, the PDF Info dict written by pdf-emit).
 *  2. C2PA Content Credentials: a signed manifest embedded in the file. Uses
 *     the engine's ephemeral self-signed signer — fully client-side, no CA —
 *     with a bounded validity window, exactly like an un-enrolled web shell.
 *  3. The Imprint invisible pixel watermark (raster only) is applied earlier,
 *     at the canvas stage in raster.ts — it must run on pixels, not bytes.
 *
 * All best-effort: a failed credential never fails the export.
 */
import { embedC2pa, exportActionSteps } from '@engine/c2pa.ts';
import type { ExportMeta } from '@engine/bridge/host-v1.ts';
import { insertPngMeta, insertJpegExif, injectSvgMeta } from '@bridge/export-image-meta.ts';

export interface ProtectOpts {
  /** Embed C2PA Content Credentials (default on, like the Lolly shell). */
  c2pa: boolean;
  /** Imprint invisible watermark — consumed by raster.ts, echoed here for the C2PA action list. */
  imprint: boolean;
  creator?: string;
  copyright?: string;
  title?: string;
}

export function buildMeta(opts: ProtectOpts): ExportMeta {
  return {
    software: 'Lolly Export for Penpot',
    source: 'https://lolly.tools/info',
    tool: 'Penpot board export',
    author: opts.creator ?? '',
    contact: '',
    description: `${opts.title || 'Penpot board'} — exported with Lolly for Penpot`,
    ...(opts.copyright ? { copyright: opts.copyright } : {}),
  };
}

/** C2PA container key for our output formats; null = can't stamp. */
function c2paFormat(ext: string): string | null {
  switch (ext) {
    case 'png': return 'png';
    case 'jpg': return 'jpg';
    case 'webp': return 'webp';
    case 'svg': return 'svg';
    case 'pdf': return 'pdf';
    default: return null;
  }
}

/**
 * Apply metadata + Content Credentials to finished bytes. `ext` is the output
 * file extension (as returned by convert()).
 */
export async function applyProtection(
  bytes: Uint8Array,
  ext: string,
  opts: ProtectOpts,
  warnings: string[],
): Promise<Uint8Array> {
  const meta = buildMeta(opts);
  let out = bytes;

  try {
    if (ext === 'png') out = insertPngMeta(out, meta);
    else if (ext === 'jpg') out = insertJpegExif(out, meta);
    else if (ext === 'svg') {
      out = new TextEncoder().encode(injectSvgMeta(new TextDecoder().decode(out), meta));
    }
    // PDF authorship lives in the Info dict pdf-emit writes.
  } catch (e) {
    console.warn('[lolly-export] metadata embed failed', e);
  }

  const fmt = c2paFormat(ext);
  if (opts.c2pa && fmt) {
    try {
      out = await embedC2pa(out, fmt, {
        title: opts.title || 'Penpot board',
        claimGenerator: 'Lolly-Export-for-Penpot lolly.tools',
        generatorInfo: { name: 'Lolly Export for Penpot', version: '0.1.0' },
        environment: { host: 'penpot-plugin' },
        ...(opts.creator ? { author: { name: opts.creator } } : {}),
        ...(opts.copyright ? { rights: opts.copyright } : {}),
        actions: exportActionSteps(fmt, { delivered: true, imprint: opts.imprint }),
        // Ephemeral self-signed signer: bounded validity window.
        dates: { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 30 * 86_400_000) },
      });
    } catch (e) {
      console.warn('[lolly-export] C2PA embed failed', e);
      warnings.push('Content Credentials could not be embedded.');
    }
  }
  return out;
}

/**
 * Distinct solid colours used in an SVG document (fills + strokes), most
 * frequent first. Feeds the print colour bars and the HDR boost targets.
 */
export function extractSvgPalette(svgText: string, limit = 6): string[] {
  const counts = new Map<string, number>();
  const add = (hex: string): void => {
    let h = hex.toLowerCase();
    if (h.length === 4) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  };
  for (const m of svgText.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\b/g)) {
    add(m[1]!);
  }
  // Penpot also emits functional notation: style="fill: rgb(48, 186, 120)".
  for (const m of svgText.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/g)) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (r <= 255 && g <= 255 && b <= 255) {
      add(`#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`);
    }
  }
  return [...counts.entries()]
    .filter(([hex]) => hex !== '#ffffff' && hex !== '#000000')
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hex]) => hex);
}
