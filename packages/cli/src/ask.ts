// How a person is asked when there is no desktop app or MCP client to ask them:
// a question in the terminal, or the operating system's own dialog box.
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { describe, type Ask, type Answer } from '@ands/core';

const TIER = { he: { change: 'שינוי', sensitive: 'רגיש', read: 'קריאה' }, en: { change: 'change', sensitive: 'sensitive', read: 'read' } };

export function question(ask: Ask, lang: 'he' | 'en') {
  const what = describe(ask.action, lang);
  const why = ask.action.why ? (lang === 'he' ? `\nלמה: ${ask.action.why}` : `\nWhy: ${ask.action.why}`) : '';
  return `${what} [${TIER[lang][ask.tier]}]${why}`;
}

/** Terminal prompt: y = yes, a = yes to every change in this task (never sensitive ones), anything else = no. */
export function terminalApprover(lang: 'he' | 'en', input = process.stdin, output = process.stderr) {
  return async (ask: Ask): Promise<Answer> => {
    const rl = createInterface({ input, output });
    const hint = ask.tier === 'sensitive' ? '[y/N]' : '[y/a/N]';
    const a = (await rl.question(`\n? ${question(ask, lang)}\n  ${hint} `)).trim().toLowerCase();
    rl.close();
    if (a === 'y' || a === 'yes' || a === 'כ' || a === 'כן') return 'yes';
    if ((a === 'a' || a === 'all') && ask.tier !== 'sensitive') return 'yes_for_task';
    return 'no';
  };
}

/** The OS dialog box: macOS osascript, Windows PowerShell, Linux zenity. No dialog available means no. */
export function dialogApprover(lang: 'he' | 'en', run = spawnSync) {
  return async (ask: Ask): Promise<Answer> => {
    const text = `ands: ${question(ask, lang)}`;
    const yes = lang === 'he' ? 'כן' : 'Yes';
    const no = lang === 'he' ? 'לא' : 'No';
    if (process.platform === 'darwin') {
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const r = run('osascript', ['-e', `button returned of (display dialog "${esc(text)}" buttons {"${no}", "${yes}"} default button "${no}" with title "ands" with icon caution giving up after 120)`], { encoding: 'utf8' });
      return String(r.stdout ?? '').trim() === yes ? 'yes' : 'no';
    }
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text.replace(/'/g, "''")}', 'ands', 'YesNo', 'Warning')`;
      const r = run('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      return String(r.stdout ?? '').trim() === 'Yes' ? 'yes' : 'no';
    }
    const r = run('zenity', ['--question', '--title=ands', `--text=${text}`, `--ok-label=${yes}`, `--cancel-label=${no}`, '--timeout=120'], { encoding: 'utf8' });
    return r.status === 0 ? 'yes' : 'no';
  };
}
