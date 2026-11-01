// The approval gate. It sits between the model's tool calls and the engine, so nothing the model
// reads (a web page, an email, a prompt) can argue its way past it.
import { classify, isBlocked, DEFAULT_BLOCKED_APPS, type Action, type Tier } from './policy.ts';

/** How much ands asks. `ask_all`: every change. `ask_important` (default): only sensitive steps, the ones that
 *  send, pay, delete, install or can't be undone; ordinary clicks and typing go through, for ands' own plan and
 *  for an outside agent alike.
 *  `autopilot`: nothing is asked; the person switched this on themselves in the app or CLI settings (no tool can).
 *  Do-not-touch apps stay blocked in every mode. */
export type Trust = 'ask_all' | 'ask_important' | 'autopilot';
export const TRUSTS: readonly Trust[] = ['ask_all', 'ask_important', 'autopilot'];

export type Ask = { action: Action; tier: Tier; task?: string };
export type Answer = 'yes' | 'no' | 'yes_for_task';

/** Shows the question to a person: desktop popup, MCP elicitation, terminal prompt, or a WhatsApp message via lvlz. */
export type Approver = (ask: Ask) => Promise<Answer>;

export type Verdict = { allowed: true; tier: Tier } | { allowed: false; tier: Tier; reason: string };

export class Gate {
  trust: Trust;
  approver: Approver;
  blocked: string[];
  /** Set when the person approves the whole plan, or says "yes to everything in this task". Never covers sensitive steps. */
  planApproved = false;
  task?: string;

  constructor(o: { trust?: Trust; approver: Approver; blocked?: string[] }) {
    this.trust = o.trust ?? 'ask_important';
    this.approver = o.approver;
    this.blocked = o.blocked ?? DEFAULT_BLOCKED_APPS;
  }

  startTask(task: string) { this.task = task; this.planApproved = false; }

  async check(action: Action): Promise<Verdict> {
    const tier = classify(action);
    if (isBlocked(action.app, this.blocked)) return { allowed: false, tier, reason: `${action.app} is on the do-not-touch list.` };
    if (tier === 'read' || this.trust === 'autopilot') return { allowed: true, tier };
    if (tier === 'change' && (this.planApproved || this.trust === 'ask_important')) return { allowed: true, tier };
    const answer = await this.approver({ action, tier, task: this.task });
    if (answer === 'no') return { allowed: false, tier, reason: 'The person said no.' };
    if (answer === 'yes_for_task' && tier === 'change') this.planApproved = true;
    return { allowed: true, tier };
  }
}

/** One plain sentence for the approval card, in the person's language. */
export function describe(a: Action, lang: 'he' | 'en' = 'en'): string {
  const what = a.target?.name ? `"${a.target.name}"` : a.ref ?? '';
  const where = a.app ? (lang === 'he' ? ` ב-${a.app}` : ` in ${a.app}`) : '';
  const he: Record<string, string> = {
    click: `ללחוץ על ${what}${where}`, 'double-click': `ללחוץ פעמיים על ${what}${where}`, type: `להקליד ״${a.value ?? ''}״ ב-${what}`,
    set_value: `לכתוב ״${a.value ?? ''}״ ב-${what}`, select: `לבחור ״${a.value ?? ''}״ ב-${what}`, toggle: `לשנות את ${what}${where}`,
    press: `ללחוץ על המקש ${a.value ?? ''}${where}`, launch: `לפתוח את ${a.app ?? a.value ?? ''}`, close: `לסגור את ${a.app ?? ''}`,
    clipboard_get: 'לקרוא את מה שהעתקת', clipboard_set: 'להעתיק טקסט ללוח', screenshot: `לצלם את המסך${where}`,
    files_trash: `להעביר לפח: ${a.value ?? ''}`, files_move: `להעביר: ${a.value ?? ''}`, files_copy: `להעתיק: ${a.value ?? ''}`,
    files_mkdir: `ליצור תיקייה: ${a.value ?? ''}`, files_open: `לפתוח: ${a.value ?? ''}`, open_url: `לפתוח את ${a.value ?? ''}${where}`,
    files_empty_trash: 'לרוקן את הפח', files_download: `להוריד: ${a.value ?? ''}`,
  };
  const en: Record<string, string> = {
    click: `Click ${what}${where}`, 'double-click': `Double-click ${what}${where}`, type: `Type "${a.value ?? ''}" into ${what}`,
    set_value: `Write "${a.value ?? ''}" in ${what}`, select: `Choose "${a.value ?? ''}" in ${what}`, toggle: `Switch ${what}${where}`,
    press: `Press ${a.value ?? ''}${where}`, launch: `Open ${a.app ?? a.value ?? ''}`, close: `Quit ${a.app ?? ''}`,
    clipboard_get: 'Read what you copied', clipboard_set: 'Copy text to the clipboard', screenshot: `Take a screenshot${where}`,
    files_trash: `Move to the Trash: ${a.value ?? ''}`, files_move: `Move: ${a.value ?? ''}`, files_copy: `Copy: ${a.value ?? ''}`,
    files_mkdir: `Make a folder: ${a.value ?? ''}`, files_open: `Open: ${a.value ?? ''}`, open_url: `Open ${a.value ?? ''}${where}`,
    files_empty_trash: 'Empty the Trash', files_download: `Download: ${a.value ?? ''}`,
  };
  return (lang === 'he' ? he : en)[a.verb] ?? `${a.verb} ${what}${where}`;
}
