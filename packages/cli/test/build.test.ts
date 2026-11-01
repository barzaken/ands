import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-ignore: plain .mjs build script
import { build, transpile } from '../../../scripts/build-npm.mjs';

test('transpile strips types and points imports at built files', () => {
  const js = transpile("import { a, type B } from './x.ts';\nimport { c } from '@ands/core';\nconst n: number = 1;", '../core/index.js');
  assert.match(js, /from '\.\/x\.js'/);
  assert.match(js, /from '\.\.\/core\/index\.js'/);
  assert.doesNotMatch(js, /: number/);
});

test('the built package runs on plain Node and has no runtime dependencies', async () => {
  const out = build();
  const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'andsh');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.bin.andsh, 'dist/bin.js');
  for (const f of readdirSync(join(out, 'dist/core'))) assert.doesNotMatch(readFileSync(join(out, 'dist/core', f), 'utf8'), /from '[^']+\.ts'/);
  const core = await import(pathToFileURL(join(out, 'dist/core/index.js')).href);
  assert.equal(typeof core.runTool, 'function');
  assert.equal(typeof core.ensureEngine, 'function');
  const { VERSION } = await import(pathToFileURL(join(out, 'dist/cli/version.js')).href);
  assert.equal(VERSION, pkg.version);
});
