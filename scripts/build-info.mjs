// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lolly = resolve(process.env.LOLLY_DIR ?? resolve(root, '../lolly'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const engine = readFileSync(resolve(lolly, 'engine/src/version.ts'), 'utf8').match(/ENGINE_VERSION = '([^']+)'/)[1];
const tools = [];
const versions = Object.fromEntries(tools.map(id => [id, JSON.parse(readFileSync(resolve(lolly, 'community', id, 'tool.json'), 'utf8')).version]));
const inputs = ['engine', 'packages/core', 'packages/node-shell', 'schemas', 'shells/web/src/bridge', ...tools.map(id => `community/${id}`)];
writeFileSync(resolve(root, 'dist/build-info.json'), JSON.stringify({
  pluginCommit: git(root, 'rev-parse', 'HEAD'),
  pluginModified: Boolean(git(root, 'status', '--porcelain', '--untracked-files=normal')),
  lollyCommit: git(lolly, 'rev-parse', 'HEAD'),
  lollyModified: Boolean(git(lolly, 'status', '--porcelain', '--', ...inputs)),
  engineVersion: engine,
  tools: versions,
}, null, 2) + '\n');
