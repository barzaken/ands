#!/usr/bin/env node
// Builds the publishable `andsh` package into packages/cli/pkg/ with no build dependencies:
// Node's own type stripper turns each .ts file into .js, and @ands/core is copied inside the
// package, so `npx -y andsh mcp` needs nothing but Node 20+.
//   npm run build:npm             build
//   npm publish packages/cli/pkg  publish (from Bar's npm account)
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli');
const out = join(cli, 'pkg');

/** Strips types and points imports at the built files. `core` is how this file reaches core from where it lands. */
export function transpile(source, core) {
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  return js
    .replace(/(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(from\s+|import\s*\(\s*)(['"])@ands\/core(?:\/browser)?\2/g, `$1$2${core}$2`);
}

function buildDir(src, dest, core) {
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(src)) {
    if (!f.endsWith('.ts')) continue;
    writeFileSync(join(dest, f.replace(/\.ts$/, '.js')), transpile(readFileSync(join(src, f), 'utf8'), core));
  }
}

export function build() {
  const pkg = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'));
  rmSync(out, { recursive: true, force: true });
  buildDir(join(root, 'packages/core/src'), join(out, 'dist/core'), '../core/index.js');
  buildDir(join(cli, 'src'), join(out, 'dist/cli'), '../core/index.js');
  writeFileSync(join(out, 'dist/cli/version.js'), `export const VERSION = ${JSON.stringify(pkg.version)};\n`);
  const bin = join(out, 'dist/bin.js');
  writeFileSync(bin, `#!/usr/bin/env node\nimport { main } from './cli/main.js';\nmain().catch((e) => { process.stderr.write(\`ands: \${e?.message ?? e}\\n\`); process.exitCode = 1; });\n`);
  chmodSync(bin, 0o755);

  const { dependencies, devDependencies, scripts, ...keep } = pkg;
  const published = { ...keep, bin: { andsh: 'dist/bin.js', ands: 'dist/bin.js' }, files: ['dist'], engines: { node: '>=20' } };
  writeFileSync(join(out, 'package.json'), JSON.stringify(published, null, 2) + '\n');
  for (const f of ['README.md', 'LICENSE', 'NOTICE']) {
    const from = existsSync(join(cli, f)) ? join(cli, f) : join(root, f);
    if (existsSync(from)) copyFileSync(from, join(out, f));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = build();
  process.stdout.write(`built ${dir}\n`);
}
