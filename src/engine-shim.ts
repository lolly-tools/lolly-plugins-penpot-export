// SPDX-License-Identifier: MPL-2.0
/**
 * Stand-in for the `@lolly/engine` package index. The bridge modules this
 * plugin reuses (svg-ir.ts, export-image-meta.ts) import two symbols from the
 * engine's public surface; re-export just those from their home modules so the
 * bundle never pulls the full engine index (and with it handlebars + ajv).
 */
export { parseSvgPath } from '@engine/svg-path.ts';
export { crc32 } from '@engine/zip-crypto.ts';
