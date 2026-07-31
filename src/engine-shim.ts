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
export { splitCssArgs, parseGradientStop, parseGradientAngle, parseRadialGradient } from '@engine/css-paint.ts';
// …and the css-box helpers its sibling export-css.ts reaches for in turn.
export { roundedRectPath, parseCssLength, cornerRadii, uniformRadius } from '@engine/css-box.ts';
// The one colour parser the bridge asks for by name. It arrived with the
// engine's colour-space work and is what export-css.ts / export-pdf-vector.ts /
// svg-ir.ts now use to turn any CSS colour into 8-bit sRGB + alpha.
export { parseColorToSrgb8 } from '@engine/css-color.ts';
