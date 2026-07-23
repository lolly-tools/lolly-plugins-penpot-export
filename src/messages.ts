// SPDX-License-Identifier: MPL-2.0
/**
 * Typed message protocol between the sandboxed plugin (plugin.ts, no DOM) and
 * the panel UI iframe (src/ui/, full DOM + WASM). Everything crossing the
 * boundary is structured-clone friendly — plain objects and Uint8Arrays.
 */

/** What the panel needs to know about one selected shape. */
export interface ShapeInfo {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
}

export type Theme = 'light' | 'dark';

export type PluginToUi =
  | { type: 'init'; theme: Theme; selection: ShapeInfo[] }
  | { type: 'selection'; selection: ShapeInfo[] }
  | { type: 'theme'; theme: Theme }
  | {
      type: 'svg-data';
      requestId: number;
      name: string;
      width: number;
      height: number;
      /** UTF-8 bytes of the SVG document, as returned by shape.export(). */
      bytes: Uint8Array;
      /** @font-face CSS for the fonts the shape uses ('' when unavailable). */
      fontCss: string;
    }
  | { type: 'error'; requestId: number; message: string };

export type UiToPlugin =
  | { type: 'ready' }
  | { type: 'export-svg'; requestId: number; shapeId: string };
