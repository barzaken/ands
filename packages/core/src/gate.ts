// The approval gate. It sits between the model's tool calls and the engine, so nothing the model
// reads (a web page, an email, a prompt) can argue its way past it.
import { classify, isBlocked, appMode, isMoneyApp, sameApp, DEFAULT_BLOCKED_APPS, type Action, type Tier, type AppMode, type AlwaysRule } from './policy.ts';

/** How much ands asks. `ask_all`: every change. `ask_important` (default): only sensitive steps, the ones that
 *  send, pay, delete, install or can't be undone; ordinary clicks and typing go through, for ands' own plan and
 *  for an outside agent alike.
 *  `autopilot`: nothing is asked; the person switched this on themselves in the app or CLI settings (no tool can).
 *  Do-not-touch apps stay blocked in every mode. */
export type Trust = 'ask_all' | 'ask_important' | 'autopilot';
export const TRUSTS: readonly Trust[] = ['ask_all', 'ask_important', 'autopilot'];

export type Ask = { action: Action; tier: Tier; task?: string };
/** `yes_always`: yes, and don't ask again for this kind of step in this app (ordinary steps only, never money apps). */
export type Answer = 'yes' | 'no' | 'yes_for_task' | 'yes_always';

/** Shows the question to a person: desktop popup, MCP elicitation, terminal prompt, or a WhatsApp message via lvlz. */
export type Approver = (ask: Ask) => Promise<Answer>;

export type Verdict = { allowed: true; tier: Tier } | { allowed: false; tier: Tier; reason: string };

export class Gate {
  trust: Trust;
  approver: Approver;
  blocked: string[];
  /** The person's per-app rules and "always" answers. Set by the person only (settings, CLI), never by a tool.
   *  They can only skip a question for an ordinary step or add one: sensitive steps always ask, and money apps
   *  are never "auto" and never "always". */
  apps: Record<string, AppMode>;
  always: AlwaysRule[];
  /** Called when the person answers "yes, always", so the host can save the rule. */
  onAlways?: (rule: AlwaysRule) => void;
  /** Set when the person approves the whole plan, or says "yes to everything in this task". Never covers sensitive steps. */
  planApproved = false;
  task?: string;
  /** Apps set to "ask" that the person said "yes to every change in this task" for. */
  #okApps = new Set<string>();

  constructor(o: { trust?: Trust; approver: Approver; blocked?: string[]; apps?: Record<string, AppMode>; always?: AlwaysRule[]; onAlways?: (rule: AlwaysRule) => void }) {
    this.trust = o.trust ?? 'ask_important';
    this.approver = o.approver;
    this.blocked = o.blocked ?? DEFAULT_BLOCKED_APPS;
    this.apps = o.apps ?? {};
    this.always = o.always ?? [];
    this.onAlways = o.onAlways;
  }

  startTask(task: string) { this.task = task; this.planApproved = false; this.#okApps.clear(); }

  /** Whether the person's own rules already answer this ordinary step. */
  private covered(action: Action): boolean {
    const app = action.app;
    if (!app || isMoneyApp(app)) return false;
    if (appMode(this.apps, app) === 'auto') return true;
    if (this.#okApps.has(app.toLowerCase())) return true;
    return this.always.some((r) => sameApp(app, r.app) && r.verb === action.verb);
  }

  async check(action: Action): Promise<Verdict> {
    const tier = classify(action);
    const mode = appMode(this.apps, action.app);
    if (isBlocked(action.app, this.blocked) || mode === 'block') return { allowed: false, tier, reason: `${action.app} is on the do-not-touch list.` };
    if (tier === 'read' || this.trust === 'autopilot') return { allowed: true, tier };
    if (tier === 'change' && (this.planApproved || this.covered(action) || (this.trust === 'ask_important' && mode !== 'ask'))) return { allowed: true, tier };
    const answer = await this.approver({ action, tier, task: this.task });
    if (answer === 'no') return { allowed: false, tier, reason: 'The person said no.' };
    if (answer === 'yes_for_task' && tier === 'change') {
      if (mode === 'ask' && action.app) this.#okApps.add(action.app.toLowerCase());
      else this.planApproved = true;
    }
    if (answer === 'yes_always' && tier === 'change' && action.app && !isMoneyApp(action.app) && !this.covered(action)) {
      const rule: AlwaysRule = { app: action.app, verb: action.verb, at: new Date().toISOString() };
      this.always.push(rule);
      this.onAlways?.(rule);
    }
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
    files_empty_trash: 'לרוקן את הפח', files_download: `להוריד: ${a.value ?? ''}`, files_write: `ליצור קובץ: ${a.value ?? ''}`,
    'triple-click': `ללחוץ שלוש פעמים על ${what}${where}`, 'right-click': `ללחוץ קליק ימני על ${what}${where}`, hover: `להצביע על ${what}${where}`,
    type_here: `להקליד ״${a.value ?? ''}״${where}`,
    mouse_click: `ללחוץ ${a.target ? `על ${what}` : `במקום ${a.value ?? ''} במסך`}${where}`, 'mouse_double-click': `ללחוץ פעמיים ${a.target ? `על ${what}` : `במקום ${a.value ?? ''} במסך`}${where}`,
    'mouse_triple-click': `ללחוץ שלוש פעמים ${a.target ? `על ${what}` : `במקום ${a.value ?? ''} במסך`}${where}`, 'mouse_right-click': `ללחוץ קליק ימני ${a.target ? `על ${what}` : `במקום ${a.value ?? ''} במסך`}${where}`,
    'mouse_middle-click': `ללחוץ בגלגלת ${a.target ? `על ${what}` : `במקום ${a.value ?? ''} במסך`}${where}`, mouse_drag: `לגרור ${a.target ? `אל ${what}` : `במסך (${a.value ?? ''})`}${where}`,
    mouse_move: `להזיז את העכבר${where}`, mouse_scroll: `לגלול${where}`,
  };
  const en: Record<string, string> = {
    click: `Click ${what}${where}`, 'double-click': `Double-click ${what}${where}`, type: `Type "${a.value ?? ''}" into ${what}`,
    set_value: `Write "${a.value ?? ''}" in ${what}`, select: `Choose "${a.value ?? ''}" in ${what}`, toggle: `Switch ${what}${where}`,
    press: `Press ${a.value ?? ''}${where}`, launch: `Open ${a.app ?? a.value ?? ''}`, close: `Quit ${a.app ?? ''}`,
    clipboard_get: 'Read what you copied', clipboard_set: 'Copy text to the clipboard', screenshot: `Take a screenshot${where}`,
    files_trash: `Move to the Trash: ${a.value ?? ''}`, files_move: `Move: ${a.value ?? ''}`, files_copy: `Copy: ${a.value ?? ''}`,
    files_mkdir: `Make a folder: ${a.value ?? ''}`, files_open: `Open: ${a.value ?? ''}`, open_url: `Open ${a.value ?? ''}${where}`,
    files_empty_trash: 'Empty the Trash', files_download: `Download: ${a.value ?? ''}`, files_write: `Create a file: ${a.value ?? ''}`,
    'triple-click': `Triple-click ${what}${where}`, 'right-click': `Right-click ${what}${where}`, hover: `Point at ${what}${where}`,
    type_here: `Type "${a.value ?? ''}"${where}`,
    mouse_click: `Click ${a.target ? what : `the screen at ${a.value ?? ''}`}${where}`, 'mouse_double-click': `Double-click ${a.target ? what : `the screen at ${a.value ?? ''}`}${where}`,
    'mouse_triple-click': `Triple-click ${a.target ? what : `the screen at ${a.value ?? ''}`}${where}`, 'mouse_right-click': `Right-click ${a.target ? what : `the screen at ${a.value ?? ''}`}${where}`,
    'mouse_middle-click': `Middle-click ${a.target ? what : `the screen at ${a.value ?? ''}`}${where}`, mouse_drag: `Drag ${a.target ? `onto ${what}` : `on the screen (${a.value ?? ''})`}${where}`,
    mouse_move: `Move the pointer${where}`, mouse_scroll: `Scroll${where}`,
  };
  return (lang === 'he' ? he : en)[a.verb] ?? `${a.verb} ${what}${where}`;
}
