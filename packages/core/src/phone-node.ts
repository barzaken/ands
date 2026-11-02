// Node side of the phone: find adb (Android's own debug bridge), fetch Google's platform-tools on first use,
// and run it. The download comes straight from Google to this computer, and is checked against the SHA-1
// Google publishes for it in its SDK repository index (both over HTTPS from dl.google.com).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { home, loadConfig } from './config.ts';
import { Phones, type AdbRunner } from './phone.ts';

export const ANDROID_REPOSITORY = 'https://dl.google.com/android/repository/';
const INDEX = `${ANDROID_REPOSITORY}repository2-3.xml`;

const exe = (platform = process.platform) => (platform === 'win32' ? 'adb.exe' : 'adb');

/** Where Android Studio and the usual installs keep adb, so a developer's own copy is used first. */
export function adbCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const list: string[] = [];
  if (env.ANDS_ADB) list.push(env.ANDS_ADB);
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) if (sdk) list.push(join(sdk, 'platform-tools', exe(platform)));
  if (platform === 'darwin') list.push(join(homedir(), 'Library/Android/sdk/platform-tools/adb'), '/opt/homebrew/bin/adb', '/usr/local/bin/adb');
  if (platform === 'win32' && env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  if (platform === 'linux') list.push(join(homedir(), 'Android/Sdk/platform-tools/adb'), '/usr/bin/adb', '/usr/local/bin/adb');
  list.push(installedAdbPath(env, platform));
  return list;
}

export function installedAdbPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  return join(home(env), 'platform-tools', exe(platform));
}

/** The platform-tools zip for this computer in Google's SDK index: its file name and SHA-1. */
export function platformToolsArchive(xml: string, platform = process.platform): { url: string; sha1: string } | undefined {
  const host = platform === 'darwin' ? 'macosx' : platform === 'win32' ? 'windows' : 'linux';
  const pkg = /<remotePackage\s+path="platform-tools">([\s\S]*?)<\/remotePackage>/.exec(xml)?.[1];
  if (!pkg) return undefined;
  for (const a of pkg.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
    const os = /<host-os>([^<]+)<\/host-os>/.exec(a[1])?.[1]?.trim();
    if (os && os !== host) continue;
    const sha1 = /<checksum(?:\s+type="sha1")?>([0-9a-f]{40})<\/checksum>/i.exec(a[1])?.[1]?.toLowerCase();
    const url = /<url>([^<]+)<\/url>/.exec(a[1])?.[1]?.trim();
    if (sha1 && url && /^[\w.-]+\.zip$/.test(url)) return { url: ANDROID_REPOSITORY + url, sha1 };
  }
  return undefined;
}

let installing: Promise<string> | undefined;

/** adb's path: a copy already on the computer, or Google's platform-tools fetched once into ~/.ands. */
export function ensureAdb(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<string> {
  const found = adbCandidates(env).find((p) => existsSync(p));
  if (found) return Promise.resolve(found);
  if (!env.ANDS_ADB) {
    try { execFileSync(exe(), ['version'], { stdio: 'ignore' }); return Promise.resolve(exe()); } catch {}
  }
  return (installing ??= installAdb(installedAdbPath(env), fetchFn).finally(() => { installing = undefined; }));
}

async function installAdb(path: string, fetchFn: typeof fetch): Promise<string> {
  const fail = (m: string) => Object.assign(new Error(m), { code: 'ADB_MISSING' });
  process.stderr.write("ands: getting Android's platform-tools from Google (one time, about 7 MB; Android SDK License: https://developer.android.com/studio/terms)…\n");
  const idx = await fetchFn(INDEX).catch(() => undefined);
  if (!idx?.ok) throw fail('could not reach Google to get adb. Check the internet connection, or install Android platform-tools and set ANDS_ADB.');
  const archive = platformToolsArchive(await idx.text());
  if (!archive) throw fail('Google\'s index had no platform-tools for this computer.');
  const res = await fetchFn(archive.url);
  if (!res.ok) throw fail(`could not download adb (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash('sha1').update(bytes).digest('hex') !== archive.sha1) throw fail('the downloaded platform-tools failed its checksum, so ands did not use them.');

  const dir = join(path, '..');
  mkdirSync(join(dir, '..'), { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(`${dir}.part-`);
  try {
    const zip = join(tmp, 'platform-tools.zip');
    writeFileSync(zip, bytes);
    // Windows 10+ and macOS ship bsdtar, which reads zip; Linux has unzip.
    if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp], { stdio: 'ignore' });
    else if (process.platform === 'darwin') execFileSync('/usr/bin/tar', ['-xf', zip, '-C', tmp], { stdio: 'ignore' });
    else execFileSync('unzip', ['-q', zip, '-d', tmp], { stdio: 'ignore' });
    rmSync(zip);
    const inner = join(tmp, 'platform-tools');
    if (!existsSync(join(inner, exe()))) throw new Error('the platform-tools archive had no adb in it.');
    if (process.platform !== 'win32') chmodSync(join(inner, exe()), 0o755);
    rmSync(dir, { recursive: true, force: true });
    renameSync(inner, dir);
  } catch (e: any) {
    throw fail(`could not unpack adb: ${e?.message ?? e}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.stderr.write('ands: adb ready.\n');
  return path;
}

/** Runs one adb command. */
export const runAdb: AdbRunner = async (args, o = {}) => {
  let bin: string;
  try { bin = await ensureAdb(); }
  catch (e: any) { return { ok: false, out: '', code: 'ADB_MISSING', message: `ands could not set up adb: ${e.message}` }; }
  const timeoutMs = o.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let err = '';
    let done = false;
    const finish = (r: Awaited<ReturnType<AdbRunner>>) => { if (!done) { done = true; resolve(r); } };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, out: '', code: 'TIMEOUT', message: `the phone took over ${timeoutMs}ms` }); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, out: '', code: 'ADB_FAILED', message: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      const text = o.binary ? buf.toString('base64') : buf.toString('utf8');
      if (code === 0) return finish({ ok: true, out: text });
      const msg = (err || buf.toString('utf8')).trim().slice(0, 500);
      const c = /unauthorized/i.test(msg) ? 'PHONE_UNAUTHORIZED' : /not found|no devices|offline/i.test(msg) ? 'NO_PHONE' : 'ADB_FAILED';
      finish({ ok: false, out: text, code: c, message: msg || `adb exited with ${code}` });
    });
  });
};

/** The person's phones as ~/.ands/config.json lists them. */
export const nodePhones = (env: NodeJS.ProcessEnv = process.env) => new Phones({ adb: runAdb, iphones: loadConfig(env).iphones ?? [] });
