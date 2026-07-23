// Headless smoke test: feed a synthetic vector IR through every emitter and
// sanity-check the output bytes. Bundled by scripts/smoke.sh (esbuild) and run
// under Node — no DOM needed for these paths (irToSvg with no image prims).
import { emitPrintPdf } from '../src/ui/pdf-emit.ts';
import { irToSvg } from '../src/ui/svg-emit.ts';
import { emitEps } from '@engine/eps.ts';
import { emitDxf } from '@engine/dxf.ts';
import { emitEmf } from '@engine/emf.ts';
import type { VectorIr } from '@engine/emf.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const ir: VectorIr = {
  width: 400,
  height: 300,
  prims: [
    {
      type: 'path',
      subpaths: [
        {
          closed: true,
          segments: [
            { op: 'M', x: 40, y: 40 },
            { op: 'L', x: 360, y: 40 },
            { op: 'L', x: 360, y: 260 },
            { op: 'C', x1: 360, y1: 280, x2: 340, y2: 280, x: 320, y: 260 },
            { op: 'L', x: 40, y: 260 },
          ],
        },
      ],
      fill: { r: 12, g: 132, b: 120 },
      stroke: { r: 24, g: 25, b: 27, width: 3 },
      fillRule: 'nonzero',
    },
    {
      type: 'image',
      x: 100, y: 90, w: 200, h: 120,
      pxW: 2, pxH: 2,
      rgb: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    },
  ],
};

const assert = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${what}`);
  console.log(`ok: ${what}`);
};

mkdirSync('dist/smoke', { recursive: true });

const pdf = await emitPrintPdf(ir, {
  width: 105, height: 74, unit: 'mm', bleed: '3mm',
  marks: { crop: true, registration: true, colorBars: true },
  pdfx: true, title: 'Smoke board',
});
const pdfStr = new TextDecoder('latin1').decode(pdf);
assert(pdfStr.startsWith('%PDF-1.6'), 'PDF header');
assert(pdfStr.includes('%%EOF'), 'PDF EOF');
assert(pdfStr.includes('/TrimBox'), 'PDF TrimBox');
assert(pdfStr.includes('/OutputIntents'), 'PDF OutputIntent');
assert(pdfStr.includes('GTS_PDFXVersion'), 'PDF/X claim in XMP');
assert(/startxref\n\d+\n%%EOF/.test(pdfStr), 'xref pointer');
// 105mm trim + 3mm bleed + 30pt mark reach each side → 374.6pt page width
const media = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdfStr)!;
assert(Math.abs(Number(media[1]) - 374.6) < 0.5, `page width in points (got ${media[1]})`);
// xref offset actually points at the xref table
const startxref = Number(/startxref\n(\d+)\n/.exec(pdfStr)![1]);
assert(pdfStr.slice(startxref, startxref + 4) === 'xref', 'xref offset lands on table');
// every object offset in the xref resolves to "N 0 obj"
const xrefBlock = /xref\n0 (\d+)\n([\s\S]+?)trailer/.exec(pdfStr)!;
const entries = xrefBlock[2]!.trim().split('\n').slice(1);
entries.forEach((line, i) => {
  const off = Number(line.slice(0, 10));
  assert(pdfStr.slice(off).startsWith(`${i + 1} 0 obj`), `xref entry ${i + 1} offset`);
});
writeFileSync('dist/smoke/smoke.pdf', pdf);

const irNoImages: VectorIr = { ...ir, prims: ir.prims.filter((p) => p.type === 'path') };
const svg = irToSvg(irNoImages, { width: 105, height: 74, unit: 'mm' });
assert(svg.includes('viewBox="0 0 400 300"'), 'SVG viewBox');
assert(svg.includes('width="105mm"'), 'SVG physical width');
assert(svg.includes('<path d="M40 40'), 'SVG path data');
writeFileSync('dist/smoke/smoke.svg', svg);

const eps = emitEps(ir, { width: 105, height: 74, unit: 'mm' });
assert(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0'), 'EPS header');
writeFileSync('dist/smoke/smoke.eps', eps);

const dxf = emitDxf(ir, {});
assert(dxf.text.includes('ENTITIES'), 'DXF entities');
assert(dxf.droppedImages === 1, 'DXF reports dropped image');
writeFileSync('dist/smoke/smoke.dxf', dxf.text);

const emf = emitEmf(ir, {});
assert(emf[0] === 0x01 && emf[1] === 0x00, 'EMF header record');
writeFileSync('dist/smoke/smoke.emf', Buffer.from(emf));

console.log('\nAll emitter smoke tests passed. Outputs in dist/smoke/.');
