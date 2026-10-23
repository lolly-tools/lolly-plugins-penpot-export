// SPDX-License-Identifier: MPL-2.0
/**
 * Stand-in for the `@lolly/engine` package index. The bridge modules this
 * plugin reuses (svg-ir.ts, export-image-meta.ts, export-pdf-vector.ts) import a
 * handful of symbols from the engine's public surface; re-export just those from
 * their home modules so the bundle never pulls the full engine index (and with
 * it handlebars + ajv).
 */
export { parseSvgPath } from '@engine/svg-path.ts';
export { crc32 } from '@engine/zip-crypto.ts';
// export-pdf-vector.ts — the brand CMYK / spot-colour palette machinery.
export { rgbToCmyk } from '@engine/color.ts';
// The rest of that machinery, which export-pdf-vector.ts started importing from
// the engine index when the PDF writer moved to pdf-lib (2026-09-11): the
// hex → CMYK/spot lookup it builds once per export, its cache key, and the
// all-black plate a finish mask prints on. Types (BrandPaletteEntry,
// PaletteHit, PaletteSpotHit) need no entry here: tsconfig.json points
// `@lolly/engine` at the real engine index, so only runtime symbols pass
// through this shim.
export { FINISH_MASK_CMYK, buildCmykPaletteMap, cmykKey } from '@engine/cmyk-palette.ts';
export { splitCssArgs, parseGradientStop, parseGradientAngle, parseRadialGradient } from '@engine/css-paint.ts';
// …and the css-box helpers its sibling export-css.ts reaches for in turn.
export { roundedRectPath, parseCssLength, cornerRadii, uniformRadius } from '@engine/css-box.ts';
// The one colour parser the bridge asks for by name. It arrived with the
// engine's colour-space work and is what export-css.ts / export-pdf-vector.ts /
// svg-ir.ts now use to turn any CSS colour into 8-bit sRGB + alpha.
export { parseColorToSrgb8 } from '@engine/css-color.ts';

// Shared text and PDF bridges now use these parts of the engine as well.
export { composeText } from '@engine/text-layout.ts';
export { parseTextDocument } from '@engine/text-story-document.ts';
export { TextSourceError, textBoundaries } from '@engine/text-source.ts';
export { sfntKind, woffToSfnt } from '@engine/font-convert.ts';
export { parseDimension, toPoints } from '@engine/units.ts';
export { computePrintGeometry } from '@engine/print-marks.ts';
export { buildEncryptDictValues, preparePassword, encryptObjectBytes } from '@engine/pdf-crypto-r6.ts';
export { toolCredit } from '@engine/metadata.ts';
export { buildPdfXXmp, formatPdfDate, makeDocumentId, pdfxOutputIntentSpec, PDFX_VERSION } from '@engine/pdfx.ts';
