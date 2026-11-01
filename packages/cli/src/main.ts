// The `ands` command: hands for AI agents. `ands mcp` serves any MCP agent; `ands link` connects a cloud agent.
import { Engine, runEngine, ensureEngine, loadConfig, saveConfig, readLog, TRUSTS, type Trust } from '@ands/core';
import { createInterface } from 'node:readline/promises';
import { serveStdio, clientConfig } from './mcp.ts';
import { VERSION } from './version.ts';
import { link, connect } from './link.ts';

const AUTOPILOT_WARNING = "In autopilot, ands doesn't ask before it acts, even before things that can't be undone: sending messages and emails, payments and purchases, deleting files, submitting forms and installing. AI can make mistakes, click the wrong thing or be misled by text it reads. Don't use it for tasks involving money, messages to others, or anything you can't undo.";

/** Autopilot is only turned on by a person who typed "yes" to the warning, every time. */
async function autopilotConsent(): Promise<boolean> {
  if (!process.stdin.isTTY) { console.error('Autopilot can only be turned on from an interactive terminal.'); return false; }
  console.error(`\n${AUTOPILOT_WARNING}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = await rl.question('Type yes to accept full responsibility for every action taken in autopilot (https://ands.sh/en/terms#autopilot): ');
  rl.close();
  return a.trim().toLowerCase() === 'yes';
}

const HELP = `ands ${VERSION}: hands for AI agents

  ands mcp                   run as an MCP server on stdio (your agent drives, ands asks you)
  ands look [--app NAME]     what ands sees in an app right now
  ands trust ask_all|ask_important|autopilot   autopilot: no questions (do-not-touch apps stay blocked)
  ands lang he|en
  ands history [--last N]    every action, who asked, and whether you approved
  ands mcp --config CLIENT   print setup for claude-code, cursor, claude-desktop, vscode, codex
  ands doctor                check the engine and permissions
  ands link                  connect a cloud agent (lvlz, any MCP-by-URL agent): prints its address, stays online
  ands link --new | --off    a fresh address, or turn the link off
  ands connect               go online again with the saved link
`;

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': return out(HELP);
    case 'version': case '--version': case '-v': return out(VERSION);
    case 'mcp': { const c = flag(rest, '--config') ?? flag(rest, '--print-config'); return c ? out(clientConfig(c)) : serveStdio(); }
    case 'trust': {
      if (!TRUSTS.includes(rest[0] as Trust)) return out(loadConfig().trust);
      if (rest[0] === 'autopilot' && !(await autopilotConsent())) return out('Autopilot stays off.');
      saveConfig({ trust: rest[0] as Trust });
      return out(`Trust: ${rest[0]}`);
    }
    case 'lang': if (rest[0] !== 'he' && rest[0] !== 'en') return out(loadConfig().lang); saveConfig({ lang: rest[0] }); return out(`Language: ${rest[0]}`);
    case 'history': {
      for (const e of readLog(Number(flag(rest, '--last') ?? 30))) out(`${e.at.slice(0, 19).replace('T', ' ')}  ${e.allowed ? (e.ok === false ? '✗' : '✓') : '⊘'}  ${e.tier.padEnd(9)} ${e.source.padEnd(12)} ${e.verb} ${e.app ?? ''} ${e.target ?? ''}${e.note ? `  (${e.note})` : ''}`);
      return;
    }
    case 'look': { const e = await new Engine(runEngine).snapshot({ app: flag(rest, '--app') }); return out(JSON.stringify(e.ok ? e.data : e.error, null, 2)); }
    case 'doctor': {
      try { out(`✓ engine: ${await ensureEngine()}`); }
      catch (e: any) { err(`✗ engine: ${e.message}`); process.exitCode = 1; return; }
      const e = await new Engine(runEngine).permissions();
      out(JSON.stringify(e.ok ? e.data : e.error, null, 2));
      return;
    }
    case 'link': return link(rest);
    case 'connect': return connect();
    default: { err(`Unknown command ${cmd}\n`); process.exitCode = 1; return out(HELP); }
  }
}
