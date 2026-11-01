// Settings and the action log live in ~/.ands (or ANDS_HOME). Nothing here leaves the computer.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BLOCKED_APPS } from './policy.ts';
import type { Trust } from './gate.ts';

export type Config = { trust: Trust; lang: 'he' | 'en'; blocked: string[] };

export const home = (env = process.env) => env.ANDS_HOME || join(homedir(), '.ands');

export function loadConfig(env = process.env): Config {
  const base: Config = { trust: 'ask_important', lang: 'en', blocked: DEFAULT_BLOCKED_APPS };
  let saved: Partial<Config> = {};
  try { saved = JSON.parse(readFileSync(join(home(env), 'config.json'), 'utf8')); } catch {}
  const c = { ...base, ...saved };
  return c;
}

export function saveConfig(patch: Partial<Config>, env = process.env): Config {
  const dir = home(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let saved: Partial<Config> = {};
  try { saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); } catch {}
  const next = { ...saved, ...patch };
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(next, null, 2));
  try { chmodSync(file, 0o600); } catch {}
  return loadConfig(env);
}

export type { LogEntry } from './tools.ts';
import type { LogEntry } from './tools.ts';

/** Every action, allowed or refused, one JSON line. Typed values are never written: only that something was typed. */
export function log(e: Omit<LogEntry, 'at'>, env = process.env) {
  try {
    mkdirSync(home(env), { recursive: true, mode: 0o700 });
    appendFileSync(join(home(env), 'history.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  } catch {}
}

export function readLog(limit = 50, env = process.env): LogEntry[] {
  try {
    return readFileSync(join(home(env), 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  } catch { return []; }
}
