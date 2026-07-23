# Lolly plugins for Penpot

Penpot plugins powered by the [Lolly](https://lolly.tools) engine. Everything
runs client-side in the user's browser — there is no server component, so
hosting is static files only.

## Plugin: Lolly Export

Export any selected board or shape to formats Penpot doesn't do natively:

| Format | What you get |
|---|---|
| **Print PDF** | True physical page size (mm/cm/in/pt), bleed, crop/registration marks, colour bars seeded with the frame's own colours, optional PDF/X-4 metadata with embedded sRGB output intent |
| **Screen PDF** | RGB, page = artwork, no marks — for sharing |
| **SVG** | Penpot's vectors with the `@font-face` CSS inlined as data: URIs — self-contained |
| **EPS / EMF / DXF** | PostScript, Windows metafile (vector paste into Office), CAD outlines |
| **PNG / JPEG / WebP** | Raster at a chosen DPI, with the density written into the file (PNG `pHYs`, JFIF density) |

Plus two option groups mirroring the Lolly web shell:

- **Content protection** — C2PA Content Credentials (engine ephemeral
  self-signed signer, fully client-side), the Imprint invisible pixel
  watermark (raster), and creator/rights metadata written to each format's
  native slot (PNG iTXt, JPEG EXIF, SVG `<metadata>`, PDF Info).
- **HDR (Rec.2100 PQ)** — PNG/JPEG only, off by default. The engine's
  lightness-gated boost with the frame's own colours as targets, four author
  dials (White/Reach/Dark lift/Focus), a `cICP` chunk + Rec2100-PQ ICC on PNG
  and the PQ ICC on JPEG. WebP is deliberately excluded (no viable HDR decode
  path). Platforms that re-encode uploads destroy HDR — use where the
  destination supports it. |

### How it works

```
Penpot sandbox (src/plugin.ts)                Panel iframe (src/ui/)
──────────────────────────────                ─────────────────────────────
selection / themechange  ──────────────────▶  panel state
                          ◀──────────────────  export request {shapeId}
shape.export({type:'svg'})
penpot.generateFontFaces() ────────────────▶  SVG bytes + @font-face CSS
                                              │
                                              ▼
                                   svgDomToIr()  (lolly web-shell bridge)
                                   — walks the SVG into a flat vector IR
                                   — outlines <text> via HarfBuzz WASM
                                              │
                            ┌─────────────────┼──────────────────┐
                            ▼                 ▼                  ▼
                     emitPrintPdf()    emitEps/Emf/Dxf()    irToSvg() → canvas
                     (src/ui/pdf-emit) (lolly engine)       raster @ DPI
```

The SVG→IR walk, HarfBuzz text-to-path bridge, and the EPS/EMF/DXF emitters
are the Lolly engine + web-shell modules, imported directly from a sibling
checkout. The print-PDF writer (`src/ui/pdf-emit.ts`) is this repo's own —
a minimal, dependency-free PDF serializer over the engine's
`computePrintGeometry` (marks) and `pdfx` (XMP + output intent) modules.

## Development

Requires a sibling checkout of the lolly repo (with `npm install` run there):

```
~/Build/lolly                       ← engine + web-shell bridge modules
~/Build/lolly-plugins-penpot-export ← this repo
```

```bash
npm install
npm run build        # dist/ = UI bundle + plugin.js + manifest.json
npm run preview      # serves dist/ at http://localhost:4402 with CORS
npm run typecheck
node scripts/make-icon.mjs   # regenerate public/icon.png
```

### Trying it in Penpot

1. `npm run preview`
2. In Penpot: Plugins (`Ctrl/Cmd + Alt + P`) → install from
   `http://localhost:4402/manifest.json`
3. Select a board, open the plugin, pick a format, export.

### Standalone demo mode

Opening `http://localhost:4402/` directly (outside Penpot) activates a fake
sandbox with a built-in demo board, so the whole conversion pipeline can be
exercised — and browser-automated — without a Penpot instance.

### Headless emitter smoke test

```bash
npx esbuild scripts/smoke-entry.ts --bundle --format=esm --platform=node \
  --alias:@engine=../lolly/engine/src --alias:@bridge=../lolly/shells/web/src/bridge \
  --alias:@lolly/engine=./src/engine-shim.ts --outfile=dist/smoke.mjs && node dist/smoke.mjs
```

Feeds a synthetic IR through every emitter, asserts PDF xref integrity, page
geometry, PDF/X markers, and writes viewable outputs to `dist/smoke/`.

## Deploying

`dist/` is fully static. Host it anywhere with CORS enabled and
immutable-cache the `assets/` directory; users install via the public
`…/manifest.json` URL. Free-bandwidth static hosts (Cloudflare Pages, GitHub
Pages) are the intended target — per-user compute cost is zero because every
conversion runs in the user's own tab.

GitHub Pages hosting is wired up in `.github/workflows/deploy-pages.yml`: on
every push to `main` it clones the public lolly repo as the sibling checkout,
builds, and publishes `dist/` via GitHub Actions Pages. Pages serves
`Access-Control-Allow-Origin: *`, and the build uses relative paths
(`vite base: './'`, manifest `"version": 2`) so it works under the
project-pages subpath. Install in Penpot from:

```
https://lolly-tools.github.io/lolly-plugins-penpot-export/manifest.json
```

One-time repo setting: **Settings → Pages → Source: GitHub Actions.**

## Known limitations / open questions (spike findings pending)

- **Penpot SVG fidelity is the ceiling.** Whatever `shape.export({type:'svg'})`
  emits is what we convert. Gradients/blends/masks that the IR walk can't
  express fall back to rasterised patches (by design); test on real boards.
- **Fonts + CORS.** SVG/raster exports inline Penpot's fonts as data: URIs
  (CORS-permitting) so text renders correctly. The IR formats (PDF/EPS/EMF/DXF)
  try to outline text via HarfBuzz + @font-face discovery; when the font can't
  be fetched, the export completes **without the text** and says so in the
  status line, instead of failing.
- **Large boards** ship as one `Uint8Array` over `postMessage`; very large
  boards may need chunking.
- The artwork maps to the **trim box** — Penpot boards have no overdraw, so
  bleed widens the page and positions marks but does not extend artwork.

## Roadmap

- Phase 2: a `HostV1` bridge shell so any Lolly tool (filters, QR, mesh
  gradients…) runs inside Penpot, writing results back to the canvas via
  `uploadMediaData` / `createShapeFromSvg` — one static bundle, one
  `manifest.json` per tool.

## License

MPL-2.0, same as the Lolly engine.
