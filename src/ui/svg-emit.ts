// SPDX-License-Identifier: MPL-2.0
/**
 * Vector IR → standalone SVG. Text is already outlined to path prims by the
 * IR walk, so the output opens identically everywhere — no fonts required.
 * Raster escape-hatch prims (filters/blends the walkers can't express) embed
 * as data-URI PNGs.
 */
import type { VectorIr, VectorPathPrim, VectorImagePrim, VectorEmitOpts, Rgb } from '@engine/emf.ts';
import { parseDimension, toCssLength } from '@engine/units.ts';

const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

const hex = ({ r, g, b }: Rgb): string =>
  `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

function pathD(prim: VectorPathPrim): string {
  const parts: string[] = [];
  for (const sub of prim.subpaths) {
    for (const seg of sub.segments) {
      if (seg.op === 'M') parts.push(`M${n(seg.x)} ${n(seg.y)}`);
      else if (seg.op === 'L') parts.push(`L${n(seg.x)} ${n(seg.y)}`);
      else parts.push(`C${n(seg.x1)} ${n(seg.y1)} ${n(seg.x2)} ${n(seg.y2)} ${n(seg.x)} ${n(seg.y)}`);
    }
    if (sub.closed) parts.push('Z');
  }
  return parts.join('');
}

function imageDataUri(prim: VectorImagePrim): string {
  const { pxW, pxH, rgb } = prim;
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const cx = canvas.getContext('2d');
  if (!cx) return '';
  const img = cx.createImageData(pxW, pxH);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    img.data[i] = rgb[j]!;
    img.data[i + 1] = rgb[j + 1]!;
    img.data[i + 2] = rgb[j + 2]!;
    img.data[i + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

export function irToSvg(ir: VectorIr, opts: VectorEmitOpts = {}): string {
  // Physical size (e.g. 210mm) becomes the width/height attributes; the
  // viewBox stays in IR device px so coordinates pass through untouched.
  let wAttr = n(ir.width);
  let hAttr = n(ir.height);
  if (opts.width != null && opts.height != null && opts.unit && opts.unit !== 'px') {
    const w = parseDimension(String(opts.width), opts.unit);
    const h = parseDimension(String(opts.height), opts.unit);
    if (w && h) {
      wAttr = toCssLength(w);
      hAttr = toCssLength(h);
    }
  }

  const body: string[] = [];
  for (const prim of ir.prims) {
    if (prim.type === 'image') {
      const href = imageDataUri(prim);
      if (!href) continue;
      body.push(
        `<image x="${n(prim.x)}" y="${n(prim.y)}" width="${n(prim.w)}" height="${n(prim.h)}" ` +
        `href="${href}" preserveAspectRatio="none"/>`,
      );
      continue;
    }
    const attrs: string[] = [`d="${pathD(prim)}"`];
    attrs.push(prim.fill ? `fill="${hex(prim.fill)}"` : 'fill="none"');
    if (prim.fillRule === 'evenodd') attrs.push('fill-rule="evenodd"');
    if (prim.stroke) {
      attrs.push(`stroke="${hex(prim.stroke)}"`, `stroke-width="${n(prim.stroke.width)}"`);
    }
    body.push(`<path ${attrs.join(' ')}/>`);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wAttr}" height="${hAttr}" ` +
    `viewBox="0 0 ${n(ir.width)} ${n(ir.height)}">${body.join('')}</svg>`
  );
}
