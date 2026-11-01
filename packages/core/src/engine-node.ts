// Node side of the engine: find the agent-desktop binary, fetch it on first use, and spawn it.
// Developers get it with no setup: `npx -y andsh mcp` downloads the pinned release once, checks its
// SHA-256 against the hashes below, and keeps it in ~/.ands/engine/<version>/.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './config.ts';
import type { Envelope, Runner } from './engine.ts';

export const ENGINE_VERSION = '1.0.2';
export const ENGINE_RELEASES = 'https://github.com/vercel-labs/agent-desktop/releases/download';

/** Release archives per platform, with the SHA-256 published in that release's checksums.txt. */
export const ENGINE_BUILDS: Record<string, { target: string; sha256: string }> = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', sha256: '7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19' },
  'darwin-x64': { target: 'x86_64-apple-darwin', sha256: '8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', sha256: '864cb782e0afc8bf0df19622016b24bdbd1a83fc7749f784ee82aa49a7f845eb' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', sha256: 'ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc', sha256: 'a0ecd6e17e60a0bcfbb45533a72f2d3a7a73508769588273ef08b0477d2b9687' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', sha256: '2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222' },
};

const exe = (platform = process.platform) => (platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop');

/** Where the downloaded engine lives (it may not be there yet). */
export function installedEnginePath(env: NodeJS.ProcessEnv = process.env) {
  return join(home(env), 'engine', ENGINE_VERSION, exe());
}

/** ANDS_ENGINE if set, else the downloaded copy. */
export function enginePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANDS_ENGINE || installedEnginePath(env);
}

let installing: Promise<string> | undefined;

/** Makes sure the engine is on disk and returns its path. Downloads at most once per process. */
export function ensureEngine(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<string> {
  if (env.ANDS_ENGINE) return Promise.resolve(env.ANDS_ENGINE);
  const path = installedEnginePath(env);
  if (existsSync(path)) return Promise.resolve(path);
  return (installing ??= install(path, fetchFn).finally(() => { installing = undefined; }));
}

async function install(path: string, fetchFn: typeof fetch): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const build = ENGINE_BUILDS[key];
  if (!build) throw Object.assign(new Error(`ands does not run on ${key} yet.`), { code: 'ENGINE_MISSING' });
  const name = `agent-desktop-v${ENGINE_VERSION}-${build.target}.tar.gz`;
  process.stderr.write(`ands: getting its engine (one time, about 10 MB)…\n`);
  const res = await fetchFn(`${ENGINE_RELEASES}/v${ENGINE_VERSION}/${name}`);
  if (!res.ok) throw Object.assign(new Error(`could not download the engine (${res.status}). Check the internet connection, or set ANDS_ENGINE.`), { code: 'ENGINE_MISSING' });
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== build.sha256) throw Object.assign(new Error('the downloaded engine failed its checksum, so ands did not use it.'), { code: 'ENGINE_MISSING' });

  const dir = join(path, '..');
  mkdirSync(join(dir, '..'), { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(`${dir}.part-`);
  try {
    const archive = join(tmp, name);
    writeFileSync(archive, bytes);
    // Windows 10+ ships bsdtar as System32\tar.exe; GNU tar from PATH misreads drive letters.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xzf', archive, '-C', tmp], { stdio: 'ignore' });
    rmSync(archive);
    if (!existsSync(join(tmp, exe()))) throw new Error('the engine archive had no binary in it.');
    if (process.platform !== 'win32') chmodSync(join(tmp, exe()), 0o755);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw Object.assign(e as Error, { code: 'ENGINE_MISSING' });
  }
  process.stderr.write(`ands: engine ready.\n`);
  return path;
}

/** Runs one engine command and parses its envelope. A missing binary or bad JSON becomes an error envelope. */
export const runEngine: Runner = async (args, timeoutMs = 60_000) => {
  let bin: string;
  try { bin = await ensureEngine(); }
  catch (e: any) { return { ok: false, error: { code: 'ENGINE_MISSING', message: `ands could not set up its engine: ${e.message}` } }; }
  return new Promise<Envelope>((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (e: Envelope) => { if (!done) { done = true; resolve(e); } };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, error: { code: 'TIMEOUT', message: `engine took over ${timeoutMs}ms` } }); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ ok: false, error: { code: e.code === 'ENOENT' ? 'ENGINE_MISSING' : 'ENGINE_FAILED', message: e.code === 'ENOENT' ? `the engine is not at ${bin}. Unset ANDS_ENGINE or fix its path.` : e.message } });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(out.trim().split('\n').pop() || '')); }
      catch { finish({ ok: false, error: { code: 'BAD_OUTPUT', message: (err || out).slice(0, 500) || 'no output' } }); }
    });
  });
};
