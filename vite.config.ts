import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Sibling checkout of github.com/lolly-tools/lolly. The plugin bundles the
// Lolly engine and the web shell's SVG→vector-IR bridge straight from that
// working tree — there is no published package for either yet. CI sets
// LOLLY_DIR; locally it defaults to the sibling directory.
const LOLLY = process.env.LOLLY_DIR ? resolve(process.env.LOLLY_DIR) : resolve(HERE, '../lolly');

export default defineConfig({
  // Relative asset URLs so the same dist/ works at a domain root AND under a
  // GitHub Pages project subpath (/repo-name/).
  base: './',
  resolve: {
    alias: {
      // The web-shell bridge modules import `@lolly/engine` (the full engine
      // index, which drags in handlebars/ajv). They only use two symbols, so
      // point the specifier at a thin shim that deep-imports just those.
      '@lolly/engine': resolve(HERE, 'src/engine-shim.ts'),
      '@engine': resolve(LOLLY, 'engine/src'),
      '@bridge': resolve(LOLLY, 'shells/web/src/bridge'),
      // The bridge keeps its DOM-free halves in the workspace package
      // @lolly-tools/node-shell (svg-ir, pptx, net, …), whose exports map is
      // "./x" -> "./src/x.ts". It is source in the same checkout, never an
      // installed package, so mirror the map with a folder alias.
      '@lolly-tools/node-shell': resolve(LOLLY, 'packages/node-shell/src'),
      // The bridge modules live inside the lolly tree, so their bare imports
      // would resolve against lolly's node_modules — which CI doesn't install.
      // Pin both runtime deps to THIS repo's node_modules instead.
      idb: resolve(HERE, 'node_modules/idb'),
      harfbuzzjs: resolve(HERE, 'node_modules/harfbuzzjs'),
      // Dynamic import in font-registry.ts (woff2 → sfnt for uploaded fonts).
      // The package's exports map "./*" → "./dist/*.js", which directory
      // aliasing bypasses — point straight at the built files.
      'woff2-encoder/decompress': resolve(HERE, 'node_modules/woff2-encoder/dist/decompress.js'),
      'woff2-encoder': resolve(HERE, 'node_modules/woff2-encoder/dist/index.js'),
    },
  },
  server: {
    cors: true,
    fs: { allow: [HERE, LOLLY] },
  },
  preview: {
    cors: true,
  },
  build: {
    target: 'es2022',
  },
});
