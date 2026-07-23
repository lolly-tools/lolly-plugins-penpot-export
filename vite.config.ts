import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Sibling checkout of github.com/… lolly. The plugin bundles the Lolly engine
// and the web shell's SVG→vector-IR bridge straight from that working tree —
// there is no published package for either yet.
const LOLLY = resolve(HERE, '../lolly');

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
