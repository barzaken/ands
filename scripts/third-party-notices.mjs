#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: the licenses of everything ands ships that someone else wrote.
//   node scripts/third-party-notices.mjs --engine <path to an agent-desktop checkout at ENGINE_VERSION> \
//     --desktop <ands-cloud checkout>/apps/desktop/src-tauri
//
// Needs only cargo (no extra tools). It reads `cargo metadata` for the desktop app and for the
// agent-desktop engine, follows normal (shipped) dependencies on every platform, and copies each
// crate's own LICENSE / COPYING / NOTICE files, with identical texts printed once.
// Run it again whenever Cargo.lock or ENGINE_VERSION changes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const engineSrc = arg('--engine') ?? process.env.ANDS_ENGINE_SRC;
if (!engineSrc) throw new Error('pass --engine <agent-desktop checkout>');
// The desktop app's code is private (barzaken/ands-cloud); its shipped crates are listed here all the same.
const desktopSrc = arg('--desktop') ?? join(root, 'apps/desktop/src-tauri');

function shipped(dir, rootName) {
  const m = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }));
  const pkgs = new Map(m.packages.map((p) => [p.id, p]));
  const nodes = new Map(m.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(m.workspace_members);
  const start = m.workspace_members.find((id) => !rootName || pkgs.get(id).name === rootName);
  const seen = new Set(), stack = [start];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
  return [...seen].filter((id) => !members.has(id)).map((id) => pkgs.get(id));
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;
function licenseTexts(p) {
  const dir = dirname(p.manifest_path);
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  if (p.license_file && !files.includes(p.license_file)) files.push(p.license_file);
  return files.map((f) => { try { return readFileSync(join(dir, f), 'utf8').trim(); } catch { return null; } }).filter(Boolean);
}

// A few crates ship no license file, only the SPDX name in Cargo.toml. For those, the copyright line
// comes from the crate's authors and the text is the standard one, chosen as below.
const used = new Set();
function standard(p) {
  const who = (p.authors ?? []).map((a) => a.replace(/\s*<[^>]*>/, '')).join(', ') || `the ${p.name} authors`;
  const spdx = p.license ?? '';
  const pick = /Apache-2\.0/.test(spdx) ? 'Apache-2.0' : /\bMIT\b/.test(spdx) ? 'MIT' : /BSD-3-Clause/.test(spdx) ? 'BSD-3-Clause' : /MPL-2\.0/.test(spdx) ? 'MPL-2.0' : spdx;
  used.add(pick);
  return `Copyright (c) ${who}; used under ${pick}, [standard text](#std-${pick.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`;
}
const STANDARD = {
  'Apache-2.0': 'The full text of the Apache License 2.0 is in LICENSE in this repository and in the desktop app.',
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  'BSD-3-Clause': `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  'MPL-2.0': 'This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. A copy of the license is at https://mozilla.org/MPL/2.0/. The source code of this crate, unmodified, is at its crates.io page.',
};

const crates = new Map();
for (const [dir, name] of [[desktopSrc, undefined], [engineSrc, 'agent-desktop']]) {
  for (const p of shipped(dir, name)) crates.set(`${p.name}@${p.version}`, p);
}

const texts = new Map(); // hash -> { text, users[] }
const rows = [];
for (const [key, p] of [...crates].sort(([a], [b]) => a.localeCompare(b))) {
  const refs = [];
  for (const t of licenseTexts(p)) {
    const h = createHash('sha256').update(t).digest('hex').slice(0, 10);
    if (!texts.has(h)) texts.set(h, { text: t, users: [] });
    texts.get(h).users.push(key);
    refs.push(`[${h}](#t-${h})`);
  }
  if (!refs.length) refs.push(standard(p));
  rows.push(`| ${p.name} | ${p.version} | ${p.license ?? 'see file'} | ${refs.join(' ')} |`);
}

const out = `# Third-party notices

ands is made by the ands authors and is licensed under the Apache License 2.0 (see LICENSE and NOTICE).
It includes or downloads the software below, written by others. Each part stays under its own license,
reproduced here. Names and logos are their owners' trademarks; ands is not affiliated with or endorsed by them.

This file is generated by \`scripts/third-party-notices.mjs\`. Do not edit by hand.

## agent-desktop (the engine)

- What: the binary that reads and operates desktop apps through the OS accessibility APIs. Bundled
  unmodified inside the desktop app; the npm package \`andsh\` downloads the same unmodified release.
- Source: https://github.com/vercel-labs/agent-desktop (release ${readFileSync(join(root, 'packages/core/src/engine-node.ts'), 'utf8').match(/ENGINE_VERSION = '([^']+)'/)[1]})
- License: Apache License 2.0, full text in LICENSE in this repository (the same text).
- The engine's own Rust dependencies are listed with the app's below.

## Website assets

- Geist and Geist Mono fonts, Copyright (c) 2023 Vercel, in collaboration with basement.studio.
  SIL Open Font License 1.1 (https://openfontlicense.org).
- Simple Icons brand paths (https://simpleicons.org), CC0 1.0. Each mark is its owner's trademark,
  shown only to name that product.
- Lobe Icons model marks (https://github.com/lobehub/lobe-icons), MIT License, Copyright (c) LobeHub.
  Each mark is its owner's trademark, shown only to name that product.

The website's npm packages (Next.js, React, Motion, MDX and their dependencies) run on the server and
in the visitor's browser and keep their license headers in the built files. Their licenses are MIT,
Apache-2.0, ISC, BSD and 0BSD; Next.js's optional image library (sharp/libvips, LGPL-3.0) runs only on
the hosting server and is not distributed.

## Rust crates in the desktop app and the engine (${rows.length})

Crates come unmodified from crates.io; source for each is at https://crates.io/crates/<name>/<version>.
Where a crate offers a choice of licenses, ands uses it under the MIT or Apache-2.0 option.
MPL-2.0 crates are used unmodified; their source is available at the crates.io link above.

| Crate | Version | License | Text |
|---|---|---|---|
${rows.join('\n')}

## Standard license texts

${[...used].sort().map((k) => `### <a id="std-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-')}"></a>${k}\n\n\`\`\`\`text\n${STANDARD[k] ?? 'See https://spdx.org/licenses/' + k + '.html'}\n\`\`\`\``).join('\n\n')}

## License texts from the crates

${[...texts].map(([h, { text, users }]) => `### <a id="t-${h}"></a>${h}\n\nUsed by: ${users.join(', ')}\n\n\`\`\`\`text\n${text}\n\`\`\`\``).join('\n\n')}
`;
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), out);
process.stdout.write(`THIRD_PARTY_NOTICES.md: ${rows.length} crates, ${texts.size} distinct license texts\n`);
