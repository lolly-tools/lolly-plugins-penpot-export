// SPDX-License-Identifier: MPL-2.0
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import config from '../vite.config.ts';

const outfile = resolve('node_modules/.cache/smoke.mjs');
mkdirSync(resolve('node_modules/.cache'), { recursive: true });
await build({
  entryPoints: ['scripts/smoke-entry.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  alias: config.resolve.alias,
  logLevel: 'warning',
});
const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);
