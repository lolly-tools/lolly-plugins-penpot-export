// SPDX-License-Identifier: MPL-2.0
/**
 * Standalone dev harness. When the panel is opened directly (not inside
 * Penpot's plugin iframe), this module impersonates the sandbox side so the
 * whole conversion pipeline can be exercised in a plain browser tab:
 * `npm run preview` → http://localhost:4402/.
 */
import type { PluginToUi, UiToPlugin } from '../messages.ts';

const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="297" viewBox="0 0 420 297">
  <rect width="420" height="297" fill="#f4f1ea"/>
  <rect x="24" y="24" width="372" height="180" rx="14" fill="#0c8478" stroke="#18191b" stroke-width="3"/>
  <circle cx="96" cy="114" r="46" fill="#ffd23f"/>
  <path d="M170 80 L360 80 Q380 80 380 100 L380 148 Q380 168 360 168 L170 168 Z" fill="#18191b" fill-rule="nonzero"/>
  <rect x="24" y="228" width="120" height="45" fill="#c2554d"/>
  <rect x="156" y="228" width="120" height="45" fill="#4464ad"/>
  <rect x="288" y="228" width="108" height="45" fill="#7bd88f"/>
</svg>`;

// Exercises the strip-text-and-retry path: "Sora" has no @font-face here, so
// IR-based formats must warn rather than fail, and SVG/raster must still work.
const DEMO_TEXT_SVG = DEMO_SVG.replace(
  '</svg>',
  `<text x="40" y="286" font-family="Sora" font-size="28" fill="#18191b">Hello Penpot friends</text></svg>`,
);

export function isEmbedded(): boolean {
  return window.parent !== window;
}

/** Loop UI messages back as if a Penpot sandbox were on the other side. */
export function installDemoHost(onMessage: (msg: PluginToUi) => void): void {
  const selection = [
    { id: 'demo-board', name: 'Demo board', type: 'board', width: 420, height: 297 },
    { id: 'demo-text', name: 'Demo board with text', type: 'board', width: 420, height: 297 },
  ];
  window.addEventListener('message', (event: MessageEvent<UiToPlugin>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    if (msg.type === 'ready') {
      onMessage({ type: 'init', theme: 'dark', selection });
    } else if (msg.type === 'export-svg') {
      const withText = msg.shapeId === 'demo-text';
      onMessage({
        type: 'svg-data',
        requestId: msg.requestId,
        name: withText ? 'Demo board with text' : 'Demo board',
        width: 420,
        height: 297,
        bytes: new TextEncoder().encode(withText ? DEMO_TEXT_SVG : DEMO_SVG),
        fontCss: '',
      });
    }
  });
  console.info('[lolly-export] standalone demo mode — not inside Penpot');
}
