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
import { deflateBytes } from '@bridge/export-image-meta.ts';

export interface PrintPdfOpts extends VectorEmitOpts {
  /** Bleed as a dimension string ('3mm') or points; 0/undefined = none. */
  bleed?: string | number;
  marks?: PrintMarksFlags;
  /** Frame colours shown as swatch pairs in the colour bar. */
  palette?: PaletteSwatch[];
  /** Claim PDF/X-4 (skips the Helvetica provenance label). */
  pdfx?: boolean;
  title?: string;
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

function pathOps(prim: Extract<VectorIr['prims'][number], { type: 'path' }>, fit: ArtFit, flip: (y: number) => number): string {
  const { s, ox, oy } = fit;
  const tx = (x: number): number => ox + x * s;
  const ty = (y: number): number => flip(oy + y * s);
  let ops = '';
  if (prim.fill) ops += `${n(prim.fill.r / 255)} ${n(prim.fill.g / 255)} ${n(prim.fill.b / 255)} rg\n`;
  if (prim.stroke) {
    ops += `${n(prim.stroke.r / 255)} ${n(prim.stroke.g / 255)} ${n(prim.stroke.b / 255)} RG\n`;
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

function markOps(geo: PrintGeometry, flip: (y: number) => number, withLabels: boolean): string {
  let ops = '';
  const sw = n(geo.strokeWeight);
  // Line marks + registration circles draw in plain black — the RGB stand-in
  // for the all-inks registration colour.
  for (const line of geo.primitives.lines) {
    ops += `0 0 0 RG ${sw} w\n${n(line.x1)} ${n(flip(line.y1))} m ${n(line.x2)} ${n(flip(line.y2))} l S\n`;
  }
  for (const c of geo.primitives.circles) {
    const { cx, r } = c;
    const cy = flip(c.cy);
    const k = r * KAPPA;
    ops += `0 0 0 RG ${sw} w\n`;
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
    const [r, g, b] = cell.rgb; // RgbTriple here is 0–1 (cmykToRgbApprox), not 0–255
    ops += `${n(r)} ${n(g)} ${n(b)} rg\n`;
    ops += `${n(cell.x)} ${n(flip(cell.y + cell.h))} ${n(cell.w)} ${n(cell.h)} re f\n`;
    ops += `0 0 0 RG ${sw} w ${n(cell.x)} ${n(flip(cell.y + cell.h))} ${n(cell.w)} ${n(cell.h)} re S\n`;
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
      ops += `BT /F1 ${n(label.size)} Tf 0 0 0 rg ${cosr} ${sinr} ${nsinr} ${cosr} ${x} ${y} Tm (${esc(text)}) Tj ET\n`;
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

  const w = new PdfWriter();
  w.push('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n');

  // ── image XObjects (flate-compressed raw RGB) ──────────────────────────────
  const images = ir.prims.filter((p): p is Extract<typeof p, { type: 'image' }> => p.type === 'image');
  const imageIds = new Map<number, number>(); // prim index → object id
  {
    let idx = 0;
    for (const prim of ir.prims) {
      if (prim.type === 'image') {
        const compressed = await deflateBytes(prim.rgb);
        const id = w.streamObj(
          `/Type /XObject /Subtype /Image /Width ${prim.pxW} /Height ${prim.pxH} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
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
        content += pathOps(prim, fit, flip);
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
    content += markOps(geo, flip, withLabels);
  }
  const contentId = w.streamObj('/Filter /FlateDecode', await deflateBytes(latin1(content)));

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
      (withLabels ? ` /Font << /F1 ${fontId} 0 R >>` : '') +
      ' >>',
  );
  w.endObj();

  // ── metadata (XMP) + OutputIntent ──────────────────────────────────────────
  const documentId = makeDocumentId();
  const nowIso = new Date().toISOString();
  const xmp = buildPdfXXmp({
    createDate: nowIso,
    title: opts.title,
    creatorTool: 'Lolly Export for Penpot',
    producer: 'Lolly engine',
    documentId,
    instanceId: makeDocumentId(),
    ...(opts.pdfx ? {} : { pdfxVersion: '' }),
  });
  const metadataId = w.streamObj('/Type /Metadata /Subtype /XML', latin1(xmp));

  const intent = pdfxOutputIntentSpec('srgb');
  let intentRef = '';
  if (intent.iccBytes) {
    const iccId = w.streamObj(
      `/N ${intent.components} /Filter /FlateDecode`,
      await deflateBytes(intent.iccBytes),
    );
    const intentId = w.beginObj();
    w.push(
      `<< /Type /OutputIntent /S /${intent.subtype} ` +
        `/OutputConditionIdentifier (${esc(intent.identifier)}) ` +
        `/Info (${esc(intent.info)}) /RegistryName (${esc(intent.registry)}) ` +
        `/DestOutputProfile ${iccId} 0 R >>`,
    );
    w.endObj();
    intentRef = ` /OutputIntents [${intentId} 0 R]`;
  }

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
