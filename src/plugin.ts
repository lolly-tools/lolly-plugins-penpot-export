// SPDX-License-Identifier: MPL-2.0
/**
 * Sandbox side of the plugin. Runs inside Penpot's plugin sandbox: no DOM, no
 * WASM — so this file stays a thin proxy. All real work (SVG → vector IR →
 * PDF/EPS/EMF/DXF/raster) happens in the panel iframe, which asks for the
 * selected shape's SVG bytes + font CSS through the messages below.
 */
import type { PluginToUi, UiToPlugin, ShapeInfo } from './messages.ts';

penpot.ui.open('Lolly Export', `?theme=${penpot.theme}`, {
  width: 360,
  height: 640,
});

function send(message: PluginToUi): void {
  penpot.ui.sendMessage(message);
}

function summarize(): ShapeInfo[] {
  return penpot.selection.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    width: s.width,
    height: s.height,
  }));
}

penpot.ui.onMessage<UiToPlugin>(async (msg) => {
  if (msg.type === 'ready') {
    send({ type: 'init', theme: penpot.theme, selection: summarize() });
    return;
  }
  if (msg.type === 'export-svg') {
    const { requestId, shapeId } = msg;
    const shape =
      penpot.selection.find((s) => s.id === shapeId) ??
      penpot.currentPage?.getShapeById(shapeId) ??
      null;
    if (!shape) {
      send({ type: 'error', requestId, message: 'Shape not found — select a board and try again.' });
      return;
    }
    try {
      const bytes = await shape.export({ type: 'svg' });
      let fontCss = '';
      try {
        fontCss = await penpot.generateFontFaces([shape]);
      } catch {
        // Font faces are a progressive enhancement: without them, text that
        // can't be outlined falls back to a plain <text> element downstream.
      }
      send({
        type: 'svg-data',
        requestId,
        name: shape.name,
        width: shape.width,
        height: shape.height,
        bytes,
        fontCss,
      });
    } catch (e) {
      send({ type: 'error', requestId, message: String((e as Error)?.message ?? e) });
    }
  }
});

penpot.on('selectionchange', () => {
  send({ type: 'selection', selection: summarize() });
});

penpot.on('themechange', (theme) => {
  send({ type: 'theme', theme: theme as 'light' | 'dark' });
});
