// `ands link` and `ands connect`: let a cloud agent (lvlz, or any agent that adds an MCP server by URL)
// work on this computer through the ands relay. Signing in uses the ands account (email code);
// approvals are asked here in the terminal, never by the remote agent.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import {
  Engine, Gate, runEngine, ensureEngine, loadConfig, home, log, pair, revokeLink, serveRemote,
  SUPABASE_URL, authHeaders, requestCode, verifyCode, fresh, type Session, type Ask, type Answer,
} from '@ands/core';
import { terminalApprover } from './ask.ts';

export type Saved = { id: string; computerSecret: string; agentUrl: string };
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;
const file = (name: string, env = process.env) => join(home(env), name);
const read = <T>(name: string, env = process.env): T | undefined => { try { return JSON.parse(readFileSync(file(name, env), 'utf8')); } catch { return undefined; } };
const write = (name: string, v: unknown, env = process.env) => { mkdirSync(home(env), { recursive: true }); writeFileSync(file(name, env), JSON.stringify(v, null, 2), { mode: 0o600 }); };
const err = (s: string) => process.stderr.write(s + '\n');

/** The ands account session for this computer, signing in with an email code the first time. */
async function account(lang: 'he' | 'en'): Promise<Session> {
  const saved = read<Session>('account.json');
  if (saved) { try { const s = await fresh(saved, lang); write('account.json', s); return s; } catch {} }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const email = (await rl.question(lang === 'he' ? 'המייל שלך בחשבון ands: ' : 'Your ands account email: ')).trim();
    await requestCode(email, lang);
    for (let i = 0; i < 5; i++) {
      const code = (await rl.question(lang === 'he' ? 'הקוד שקיבלת במייל: ' : 'The code from your email: ')).trim();
      try { const s = await verifyCode(email, code, lang); write('account.json', s); return s; } catch (e: any) { err(e.message); }
    }
    throw new Error(lang === 'he' ? 'יותר מדי ניסיונות. נסו שוב.' : 'Too many tries. Run it again.');
  } finally { rl.close(); }
}

/** A remote agent never gets "yes to everything in this task": each important step is its own question. */
export const remoteApprover = (ask: (a: Ask) => Promise<Answer>) => async (a: Ask): Promise<Answer> => ((await ask(a)) === 'no' ? 'no' : 'yes');

/** Serve saved creds until Ctrl-C or until the link is turned off. */
export async function connect(saved = read<Saved>('remote.json')) {
  const cfg = loadConfig();
  if (!saved) { err(cfg.lang === 'he' ? 'אין עדיין חיבור. הריצו `ands link`.' : 'No link yet. Run `ands link` first.'); process.exitCode = 1; return; }
  await ensureEngine();
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  const gate = new Gate({ trust: cfg.trust, blocked: cfg.blocked, approver: remoteApprover(terminalApprover(cfg.lang)) });
  let revoked = false;
  await serveRemote({
    base: FUNCTIONS, link: saved, engine: new Engine(runEngine), gate, signal: ac.signal,
    onState: (s) => {
      if (s === 'revoked') revoked = true;
      err(cfg.lang === 'he'
        ? { online: '● מחובר. הסוכן יכול לעבוד במחשב הזה (Ctrl-C לעצירה).', offline: '○ אין חיבור, מנסה שוב…', revoked: 'החיבור בוטל.' }[s]
        : { online: '● Connected. Your agent can work on this computer (Ctrl-C to stop).', offline: '○ Offline, retrying…', revoked: 'This link was turned off.' }[s]);
    },
    onCall: (c) => {
      err(`  ${c.ok ? '✓' : '✗'} ${c.tool} ${c.input?.why ?? ''}`.trimEnd());
      log({ task: 'remote agent', source: 'remote', verb: c.tool.replace('ands_', ''), app: c.input?.app, tier: 'remote', allowed: true, ok: c.ok, note: c.input?.why });
    },
  });
  if (revoked) rmSync(file('remote.json'), { force: true });
}

/** Make a link for an agent, print it, then stay connected. `--off` turns the current link off. */
export async function link(args: string[]) {
  const cfg = loadConfig();
  const saved = read<Saved>('remote.json');
  if (args.includes('--off')) {
    if (saved) { await revokeLink({ base: FUNCTIONS, headers: authHeaders(await account(cfg.lang)) }, saved.id).catch(() => {}); rmSync(file('remote.json'), { force: true }); }
    err(cfg.lang === 'he' ? 'החיבור כבוי.' : 'Link turned off.');
    return;
  }
  let s = saved;
  if (!s || args.includes('--new')) {
    const l = await pair({ base: FUNCTIONS, headers: authHeaders(await account(cfg.lang)) }, hostname());
    s = { id: l.id, computerSecret: l.computerSecret, agentUrl: l.agentUrl };
    write('remote.json', s);
  }
  err(cfg.lang === 'he' ? '\nהדביקו את הכתובת הזאת בסוכן שלכם, במקום שבו מוסיפים שרת MCP:' : '\nPaste this address into your agent, where it adds an MCP server:');
  process.stdout.write(s.agentUrl + '\n\n');
  return connect(s);
}
