// SPDX-License-Identifier: MPL-2.0
/**
 * Vector IR → print-grade PDF, written byte-by-byte (no jsPDF/pdf-lib — the
 * IR is only M/L/C paths, solid fills/strokes, and opaque RGB images, so a
 * few hundred lines of real PDF beats a dependency).
 *
 * Print geometry (bleed box, crop/registration marks, colour bars) comes from
 * the engine's computePrintGeometry, PDF/X-4 metadata (XMP packet + sRGB
 * OutputIntent with embedded ICC) from the engine's pdfx module. Artwork maps
 * onto the trim box: Penpot boards have no overdraw past their edges, so a
 * requested bleed widens the page and positions the marks, but the artwork
 * itself stops at trim.
 *
 * PDF/X-4 conformance note: with `pdfx` on we claim GTS_PDFXVersion — honest
 * here because every glyph is already outlined (no fonts to embed) and the
 * sRGB OutputIntent embeds its ICC profile. Provenance labels use unembedded
 * Helvetica, so with `pdfx` on the label primitive is skipped.
 */
import type { VectorIr, VectorEmitOpts } from '@engine/emf.ts';
import {
  computePrintGeometry,
  PRINT_MARK_DEFAULTS,
  type PrintMarksFlags,
  type PrintGeometry,
  type PaletteSwatch,
} from '@engine/print-marks.ts';
import { buildPdfXXmp, makeDocumentId, pdfxOutputIntentSpec } from '@engine/pdfx.ts';
import { parseDimension, toPoints, CSS_DPI } from '@engine/units.ts';
import { srgbIccProfile, rgbToCmyk } from '@engine/color.ts';
import { deflateBytes } from '@bridge/export-image-meta.ts';
import { Separator, REGISTRATION, BLACK_ONLY, DEFAULT_CONDITION, type Cmyk4, type ColorMode, type InkLock } from './cmyk.ts';

export interface PrintPdfOpts extends VectorEmitOpts {
  /** Bleed as a dimension string ('3mm') or points; 0/undefined = none. */
  bleed?: string | number;
  marks?: PrintMarksFlags;
  /** Frame colours shown as swatch pairs in the colour bar. */
  palette?: PaletteSwatch[];
  /** Claim PDF/X-4 (skips the Helvetica provenance label). */
  pdfx?: boolean;
  title?: string;
  /** 'cmyk' emits DeviceCMYK/Separation ink operators instead of DeviceRGB. */
  color?: ColorMode;
  /** Press condition declared in the CMYK OutputIntent (see cmyk.ts). */
  condition?: string;
  /** Measured brand ink values that override the device conversion. */
  inkLocks?: InkLock[];
  /**
   * A destination ICC profile for the CMYK OutputIntent. Without one the intent
   * is registry-name-only, which is NOT strictly PDF/X-4 conformant — so the
   * conformance claim is dropped rather than faked. Press profiles (FOGRA,
   * GRACoL) aren't freely redistributable, hence the upload rather than a
   * bundled asset.
   */
  destProfile?: Uint8Array | null;
  /** Collects honesty notes (dropped X-4 claim, etc.) for the UI. */
  warn?: (message: string) => void;
}

// Circle → 4 cubic Béziers.
const KAPPA = 0.5522847498307936;

const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);

const latin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** Incremental PDF writer: objects appended in order, xref built at the end. */
class PdfWriter {
  private parts: Uint8Array[] = [];
  private length = 0;
  private offsets: number[] = [0]; // object number → byte offset (0 unused)

  push(bytes: Uint8Array | string): void {
    const b = typeof bytes === 'string' ? latin1(bytes) : bytes;
    this.parts.push(b);
    this.length += b.length;
  }

  /** Reserve the next object number without writing it yet. */
  reserve(): number {
    this.offsets.push(-1);
    return this.offsets.length - 1;
  }

  beginObj(num?: number): number {
    const id = num ?? this.reserve();
    this.offsets[id] = this.length;
    this.push(`${id} 0 obj\n`);
    return id;
  }

  endObj(): void {
    this.push('\nendobj\n');
  }

  /** Write a complete stream object; body is raw (already encoded) bytes. */
  streamObj(dict: string, body: Uint8Array, num?: number): number {
    const id = this.beginObj(num);
    this.push(`<< ${dict} /Length ${body.length} >>\nstream\n`);
    this.push(body);
    this.push('\nendstream');
    this.endObj();
    return id;
  }

  finish(rootRef: number, infoRef: number, docId: string): Uint8Array {
    const count = this.offsets.length;
    const xrefAt = this.length;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) {
      xref += `${String(this.offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    const hexId = docId.replace(/^uuid:/, '').replace(/-/g, '');
    xref +=
      `trailer\n<< /Size ${count} /Root ${rootRef} 0 R /Info ${infoRef} 0 R ` +
      `/ID [<${hexId}> <${hexId}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    this.push(xref);
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function bleedPoints(bleed: string | number | undefined): number {
  if (bleed == null) return 0;
  if (typeof bleed === 'number') return Math.max(0, bleed);
  const dim = parseDimension(bleed, 'mm');
  return dim ? toPoints(dim) : 0;
}

/** Trim size in points from the emit opts, falling back to CSS px at 96dpi. */
function trimSize(ir: VectorIr, opts: PrintPdfOpts): { w: number; h: number } {
  // Stringify before parsing: parseDimension treats bare numbers as px and
  // only applies defaultUnit to strings.
  const w = parseDimension(String(opts.width ?? ir.width), opts.unit ?? 'px');
  const h = parseDimension(String(opts.height ?? ir.height), opts.unit ?? 'px');
  if (w && h) return { w: toPoints(w), h: toPoints(h) };
  return { w: (ir.width * 72) / CSS_DPI, h: (ir.height * 72) / CSS_DPI };
}

// ─── content-stream builders (PDF coords: y-up; geometry: y-down) ────────────

/** Contain-fit of the IR into the trim box: uniform scale, centred. A size
 *  whose aspect drifts from the board's can letterbox, but never crop. */
interface ArtFit {
  s: number;
  ox: number;
  oy: number;
}

function artFit(geo: PrintGeometry, ir: VectorIr): ArtFit {
  const trim = geo.boxes.trim;
  const s = Math.min(trim.w / ir.width, trim.h / ir.height);
  return {
    s,
    ox: trim.x + (trim.w - ir.width * s) / 2,
    oy: trim.y + (trim.h - ir.height * s) / 2,
  };
}

// ─── colour operators ────────────────────────────────────────────────────────
//
// One place decides RGB vs ink for every primitive. `fill` writes the
// non-stroking operator (rg / k / scn), `stroke` the stroking one (RG / K /
// SCN) — PDF keeps the two colour slots entirely separate.

/** A DeviceCMYK ink operator from resolved 0–1 values. */
const inkOp = (c: Cmyk4, stroking: boolean): string =>
  `${n(c[0])} ${n(c[1])} ${n(c[2])} ${n(c[3])} ${stroking ? 'K' : 'k'}\n`;

/** Paint an 8-bit RGB triple in whichever space this export is emitting. */
function colorOp(sep: Separator, r: number, g: number, b: number, stroking: boolean): string {
  if (!sep.cmyk) {
    const op = stroking ? 'RG' : 'rg';
    return `${n(r / 255)} ${n(g / 255)} ${n(b / 255)} ${op}\n`;
  }
  const ink = sep.resolve(r / 255, g / 255, b / 255);
  if (ink.spot) {
    // A spot plate is its own colourspace painted at full tint. The /CSn name is
    // assigned up front so it can be written here, before the colourspace object
    // exists — emitPrintPdf materialises only the ones this stream referenced.
    const cs = sep.spotResource(ink.spot)!;
    return stroking ? `/${cs} CS 1 SCN\n` : `/${cs} cs 1 scn\n`;
  }
  return inkOp(ink.cmyk, stroking);
}

/** Paint an already-resolved ink, or its RGB stand-in outside CMYK mode. */
function markColorOp(sep: Separator, ink: Cmyk4, rgb: [number, number, number], stroking: boolean): string {
  if (sep.cmyk) return inkOp(ink, stroking);
  const op = stroking ? 'RG' : 'rg';
  return `${n(rgb[0])} ${n(rgb[1])} ${n(rgb[2])} ${op}\n`;
}

function pathOps(prim: Extract<VectorIr['prims'][number], { type: 'path' }>, fit: ArtFit, flip: (y: number) => number, sep: Separator): string {
  const { s, ox, oy } = fit;
  const tx = (x: number): number => ox + x * s;
  const ty = (y: number): number => flip(oy + y * s);
  let ops = '';
  if (prim.fill) ops += colorOp(sep, prim.fill.r, prim.fill.g, prim.fill.b, false);
  if (prim.stroke) {
    ops += colorOp(sep, prim.stroke.r, prim.stroke.g, prim.stroke.b, true);
    ops += `${n(Math.max(prim.stroke.width * s, 0.1))} w\n`;
  }
  for (const sub of prim.subpaths) {
    for (const seg of sub.segments) {
      if (seg.op === 'M') ops += `${n(tx(seg.x))} ${n(ty(seg.y))} m\n`;
      else if (seg.op === 'L') ops += `${n(tx(seg.x))} ${n(ty(seg.y))} l\n`;
      else ops += `${n(tx(seg.x1))} ${n(ty(seg.y1))} ${n(tx(seg.x2))} ${n(ty(seg.y2))} ${n(tx(seg.x))} ${n(ty(seg.y))} c\n`;
    }
    if (sub.closed) ops += 'h\n';
  }
  const star = prim.fillRule === 'evenodd' ? '*' : '';
  if (prim.fill && prim.stroke) ops += `B${star}\n`;
  else if (prim.fill) ops += `f${star}\n`;
  else if (prim.stroke) ops += 'S\n';
  else ops += 'n\n';
  return ops;
}

function markOps(geo: PrintGeometry, flip: (y: number) => number, withLabels: boolean, sep: Separator): string {
  let ops = '';
  const sw = n(geo.strokeWeight);
  // Crop, bleed and registration marks print in registration ink — all four
  // plates at full strength, so every separation carries them and the pressman
  // can align them. In RGB mode that's only expressible as black, which is the
  // stand-in this format has always used.
  const regOp = markColorOp(sep, REGISTRATION, [0, 0, 0], true);
  // Rules and provenance text stay K-only: a hairline that prints 4-colour is a
  // registration problem, not a feature.
  const kOp = markColorOp(sep, BLACK_ONLY, [0, 0, 0], true);
  const kFill = markColorOp(sep, BLACK_ONLY, [0, 0, 0], false);
  for (const line of geo.primitives.lines) {
    ops += `${regOp}${sw} w\n${n(line.x1)} ${n(flip(line.y1))} m ${n(line.x2)} ${n(flip(line.y2))} l S\n`;
  }
  for (const c of geo.primitives.circles) {
    const { cx, r } = c;
    const cy = flip(c.cy);
    const k = r * KAPPA;
    ops += `${regOp}${sw} w\n`;
    ops += `${n(cx + r)} ${n(cy)} m\n`;
    ops += `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c\n`;
    ops += `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c\n`;
    ops += `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c\n`;
    ops += `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c\nS\n`;
    // crosshair
    const cr = c.r + (PRINT_MARK_DEFAULTS.regCrossPt - PRINT_MARK_DEFAULTS.regRadiusPt);
    ops += `${n(cx - cr)} ${n(cy)} m ${n(cx + cr)} ${n(cy)} l S\n`;
    ops += `${n(cx)} ${n(cy - cr)} m ${n(cx)} ${n(cy + cr)} l S\n`;
  }
  for (const cell of geo.primitives.bars) {
    // RgbTriple here is 0–1 (cmykToRgbApprox for the ink cells), not 0–255.
    const [r, g, b] = cell.rgb;
    // In CMYK the bar becomes a real verification strip: the 'rgb' half of each
    // pair shows what the naïve device conversion of the screen colour produces,
    // the 'cmyk' half the locked ink. Side by side on press, that's exactly the
    // comparison a printer wants to eyeball.
    const ink: Cmyk4 = cell.ink === 'rgb' ? rgbToCmyk(r, g, b) : (cell.cmyk as Cmyk4);
    ops += markColorOp(sep, ink, [r, g, b], false);
    ops += `${n(cell.x)} ${n(flip(cell.y + cell.h))} ${n(cell.w)} ${n(cell.h)} re f\n`;
    ops += `${kOp}${sw} w ${n(cell.x)} ${n(flip(cell.y + cell.h))} ${n(cell.w)} ${n(cell.h)} re S\n`;
  }
  if (withLabels) {
    for (const label of geo.primitives.labels) {
      const text = 'Made with Lolly + Penpot';
      const x = n(label.x);
      const y = n(flip(label.y));
      const rot = label.rotation;
      const cosr = n(Math.cos((rot * Math.PI) / 180));
      const sinr = n(Math.sin((-rot * Math.PI) / 180));
      const nsinr = n(-Math.sin((-rot * Math.PI) / 180));
      ops += `BT /F1 ${n(label.size)} Tf ${kFill}${cosr} ${sinr} ${nsinr} ${cosr} ${x} ${y} Tm (${esc(text)}) Tj ET\n`;
    }
  }
  return ops;
}

/**
 * The engine stops the colour-bar row at the page centre when a registration
 * target sits there, so small pages fit only a pair or two of brand swatches.
 * Continue any truncated pairs on the RIGHT of the centre mark — same band,
 * same metrics — so every frame colour that physically fits gets a cell.
 */
function continueBrandPairs(geo: PrintGeometry, palette: PaletteSwatch[], registration: boolean, pageW: number): void {
  const bars = geo.primitives.bars;
  const placed = bars.filter((b) => b.ink === 'rgb').length;
  const rest = palette.slice(placed);
  if (!rest.length || !bars.length) return;
  const { barCellPt: bc, barPairGapPt: bg, regCrossPt: rc, markReachPt: reach } = PRINT_MARK_DEFAULTS;
  const y = bars[0]!.y;
  const lastEnd = Math.max(...bars.map((b) => b.x + b.w));
  let x = registration ? Math.max(lastEnd + bg, pageW / 2 + rc + 6) : lastEnd + bg;
  const maxX = pageW - reach;
  for (const { rgb, cmyk, label, spotName } of rest) {
    if (x + 2 * bc > maxX) break;
    bars.push({ x, y, w: bc, h: bc, cmyk, rgb, ink: 'rgb', label, spotName, mark: 'colorbar' });
    bars.push({ x: x + bc, y, w: bc, h: bc, cmyk, rgb, ink: 'cmyk', label, spotName, mark: 'colorbar' });
    x += 2 * bc + bg;
  }
}

export async function emitPrintPdf(ir: VectorIr, opts: PrintPdfOpts = {}): Promise<Uint8Array> {
  const { w: trimWpt, h: trimHpt } = trimSize(ir, opts);
  const bleedPt = bleedPoints(opts.bleed);
  const marks = opts.marks ?? {};
  const geo = computePrintGeometry({ trimWpt, trimHpt, bleedPt, marks, palette: opts.palette ?? [] });
  const pageW = geo.page.w;
  const pageH = geo.page.h;
  const flip = (y: number): number => pageH - y;
  const withLabels = Boolean(marks.provenance) && !opts.pdfx;
  const sep = new Separator(opts.color ?? 'rgb', opts.inkLocks ?? []);

  const w = new PdfWriter();
  w.push('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n');

  // The engine-generated sRGB profile, written once and shared by every
  // /ICCBased image colourspace and (in RGB mode) the OutputIntent.
  let srgbId = 0;
  const srgbIcc = async (): Promise<number> => {
    if (!srgbId) srgbId = w.streamObj('/N 3 /Filter /FlateDecode', await deflateBytes(srgbIccProfile()));
    return srgbId;
  };

  // ── image XObjects (flate-compressed raw RGB) ──────────────────────────────
  //
  // Pixels stay sRGB in both colour modes — rasters are late-binding and a RIP
  // separates them far better than a per-pixel device conversion here would. The
  // colourspace is /ICCBased rather than /DeviceRGB because PDF/X-4 forbids
  // device-dependent colour, and under a CMYK OutputIntent a /DeviceRGB image is
  // flatly illegal. /ICCBased is device-independent, so it's valid under either
  // intent and the file stays conformant.
  const images = ir.prims.filter((p): p is Extract<typeof p, { type: 'image' }> => p.type === 'image');
  const imageIds = new Map<number, number>(); // prim index → object id
  {
    const iccRef = images.length ? await srgbIcc() : 0;
    let idx = 0;
    for (const prim of ir.prims) {
      if (prim.type === 'image') {
        const compressed = await deflateBytes(prim.rgb);
        const id = w.streamObj(
          `/Type /XObject /Subtype /Image /Width ${prim.pxW} /Height ${prim.pxH} ` +
            `/ColorSpace [/ICCBased ${iccRef} 0 R] /BitsPerComponent 8 /Filter /FlateDecode`,
          compressed,
        );
        imageIds.set(idx, id);
      }
      idx++;
    }
  }

  // ── content stream ─────────────────────────────────────────────────────────
  let content = '';
  {
    const fit = artFit(geo, ir);
    let imgN = 0;
    for (const prim of ir.prims) {
      if (prim.type === 'path') {
        content += pathOps(prim, fit, flip, sep);
      } else {
        const x = fit.ox + prim.x * fit.s;
        const yTop = fit.oy + prim.y * fit.s;
        const dw = prim.w * fit.s;
        const dh = prim.h * fit.s;
        content += `q ${n(dw)} 0 0 ${n(dh)} ${n(x)} ${n(flip(yTop + dh))} cm /Im${imgN} Do Q\n`;
        imgN++;
      }
    }
    continueBrandPairs(geo, opts.palette ?? [], Boolean(marks.registration), pageW);
    content += markOps(geo, flip, withLabels, sep);
  }
  const contentId = w.streamObj('/Filter /FlateDecode', await deflateBytes(latin1(content)));

  // ── spot colourspaces ──────────────────────────────────────────────────────
  //
  // One /Separation per spot plate the content stream actually referenced, each
  // with a Type-2 exponential tint transform: a linear ramp from no ink at tint 0
  // to the spot's process equivalent at tint 1. That's the standard "named ink
  // with a process alternate" construction — a RIP with the real ink prints the
  // plate, anything else falls back to the CMYK build.
  let colorspaces = '';
  for (const spotName of sep.usedSpots) {
    const resourceName = sep.spotResource(spotName);
    const alt = sep.spotCmyk(spotName);
    if (!resourceName || !alt) continue;
    const fnId = w.beginObj();
    w.push(`<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [${alt.map(n).join(' ')}] /N 1 >>`);
    w.endObj();
    const csId = w.beginObj();
    w.push(`[/Separation (${esc(spotName)}) /DeviceCMYK ${fnId} 0 R]`);
    w.endObj();
    colorspaces += `/${resourceName} ${csId} 0 R `;
  }

  // ── resources ──────────────────────────────────────────────────────────────
  let xobjects = '';
  {
    let imgN = 0;
    for (const [, objId] of imageIds) {
      xobjects += `/Im${imgN} ${objId} 0 R `;
      imgN++;
    }
  }
  const fontId = withLabels
    ? (() => {
        const id = w.beginObj();
        w.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
        w.endObj();
        return id;
      })()
    : 0;
  const resourcesId = w.beginObj();
  w.push(
    `<< /ProcSet [/PDF${images.length ? ' /ImageC' : ''}${withLabels ? ' /Text' : ''}]` +
      (xobjects ? ` /XObject << ${xobjects}>>` : '') +
      (colorspaces ? ` /ColorSpace << ${colorspaces}>>` : '') +
      (withLabels ? ` /Font << /F1 ${fontId} 0 R >>` : '') +
      ' >>',
  );
  w.endObj();

  // ── OutputIntent ───────────────────────────────────────────────────────────
  //
  // The intent tells a RIP what the numbers in this file mean. RGB embeds the
  // engine's sRGB profile and is fully conformant. CMYK names the press
  // condition, and embeds a destination profile only if the caller supplied one
  // — press profiles can't ship with the plugin for licensing reasons.
  const intent = pdfxOutputIntentSpec(sep.cmyk ? (opts.condition ?? DEFAULT_CONDITION) : 'srgb');
  const destBytes = sep.cmyk ? (opts.destProfile ?? null) : intent.iccBytes;

  let destRef = '';
  if (destBytes) {
    const iccId = sep.cmyk
      ? w.streamObj(`/N ${intent.components} /Filter /FlateDecode`, await deflateBytes(destBytes))
      : await srgbIcc(); // identical bytes to the image colourspace — share the object
    destRef = ` /DestOutputProfile ${iccId} 0 R`;
  }
  const intentId = w.beginObj();
  w.push(
    `<< /Type /OutputIntent /S /${intent.subtype} ` +
      `/OutputConditionIdentifier (${esc(intent.identifier)}) ` +
      `/Info (${esc(intent.info)}) /RegistryName (${esc(intent.registry)})${destRef} >>`,
  );
  w.endObj();
  const intentRef = ` /OutputIntents [${intentId} 0 R]`;

  // ── metadata (XMP) ─────────────────────────────────────────────────────────
  //
  // Honesty gate: PDF/X-4 requires an EMBEDDED destination profile. A CMYK export
  // with only a registry name is "X-4 ready", not conformant — so the claim is
  // dropped rather than faked, and the caller is told why. Every other X-4
  // requirement is already met (all text is outlined, no device colour remains).
  const claimPdfx = Boolean(opts.pdfx) && Boolean(destBytes);
  if (opts.pdfx && !claimPdfx) {
    opts.warn?.(
      'PDF/X-4 not claimed: a CMYK output intent needs an embedded destination profile. ' +
        'Add your press ICC profile, or ask your printer which condition to use.',
    );
  }
  const documentId = makeDocumentId();
  const nowIso = new Date().toISOString();
  const xmp = buildPdfXXmp({
    createDate: nowIso,
    title: opts.title,
    creatorTool: 'Lolly Export for Penpot',
    producer: 'Lolly engine',
    documentId,
    instanceId: makeDocumentId(),
    ...(claimPdfx ? {} : { pdfxVersion: '' }),
  });
  const metadataId = w.streamObj('/Type /Metadata /Subtype /XML', latin1(xmp));

  // ── page tree, catalog, info ───────────────────────────────────────────────
  const box = (b: { x: number; y: number; w: number; h: number }): string =>
    `[${n(b.x)} ${n(pageH - (b.y + b.h))} ${n(b.x + b.w)} ${n(pageH - b.y)}]`;

  const pagesId = w.reserve();
  const pageId = w.beginObj();
  w.push(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] ` +
      `/TrimBox ${box(geo.boxes.trim)} /BleedBox ${box(geo.boxes.bleed)} ` +
      `/Contents ${contentId} 0 R /Resources ${resourcesId} 0 R >>`,
  );
  w.endObj();
  w.beginObj(pagesId);
  w.push(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  w.endObj();
  const catalogId = w.beginObj();
  w.push(`<< /Type /Catalog /Pages ${pagesId} 0 R /Metadata ${metadataId} 0 R${intentRef} >>`);
  w.endObj();
  const infoId = w.beginObj();
  const pdfDate = `D:${nowIso.replace(/[-:T]/g, '').slice(0, 14)}Z`;
  w.push(
    `<< /Title (${esc(opts.title ?? 'Penpot board')}) /Producer (Lolly engine) ` +
      `/Creator (Lolly Export for Penpot) /CreationDate (${pdfDate}) /ModDate (${pdfDate}) ` +
      `/Trapped /False >>`,
  );
  w.endObj();

  return w.finish(catalogId, infoId, documentId);
}
