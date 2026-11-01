// Every action is sorted before it runs: read (goes through), change (covered by the plan's approval
// or asked one by one), sensitive (always asks). The model never sees or sets this; it is decided here.

export type Tier = 'read' | 'change' | 'sensitive';

export type Action = {
  /** Tool-level verb: look, click, type, select, toggle, scroll, press, launch, close, clipboard_get, clipboard_set, screenshot, apps, windows */
  verb: string;
  app?: string;
  ref?: string;
  /** The role and name of the element the ref points at, when known (from the last snapshot). */
  target?: { role: string; name: string };
  value?: string;
  /** The model's one-line reason, shown to the person. Never used to lower the tier. */
  why?: string;
};

const READ = new Set(['look', 'apps', 'windows', 'find', 'get', 'is', 'wait']);

// Words on a button or key that mean the click leaves the computer, costs money, or can't be undone.
// English and Hebrew; matched against the element's accessible name, case-insensitive.
const SENSITIVE_WORDS = [
  'send', 'submit', 'post', 'publish', 'share', 'reply', 'tweet',
  'pay', 'buy', 'purchase', 'checkout', 'order', 'subscribe', 'donate', 'transfer',
  'delete', 'remove', 'erase', 'trash', 'empty trash', 'discard', 'uninstall', 'format', 'reset',
  'install', 'allow', 'grant', 'sign in', 'log in', 'login', 'sign up', 'accept', 'confirm', 'agree',
  'שלח', 'שליחה', 'פרסם', 'שתף', 'השב', 'הגש',
  'שלם', 'תשלום', 'קנה', 'רכישה', 'הזמן', 'הזמנה', 'העבר', 'העברה', 'תרום',
  'מחק', 'מחיקה', 'הסר', 'רוקן', 'אפס', 'התקן', 'התקנה', 'אשר', 'אישור', 'התחבר', 'הרשמה', 'הסכם', 'מסכים',
];

/** Apps ands never touches unless the person removes them from this list. */
export const DEFAULT_BLOCKED_APPS = ['1Password', 'Bitwarden', 'Keychain Access', 'LastPass', 'KeePassXC'];

const hasWord = (text: string, words: string[]) => {
  const t = ` ${text.toLowerCase()} `;
  return words.some((w) => {
    const i = t.indexOf(w);
    if (i < 0) return false;
    // A Latin word must stand alone ("send" yes, "sender" no). Hebrew words take prefixes (ו, ל, ש), so a substring is enough.
    if (/[a-z]/.test(w)) return !/[a-z]/.test(t[i - 1] ?? ' ') && !/[a-z]/.test(t[i + w.length] ?? ' ');
    return true;
  });
};

export function classify(a: Action): Tier {
  if (READ.has(a.verb)) return 'read';
  if (a.verb === 'clipboard_get' || a.verb === 'screenshot') return 'sensitive'; // can expose private content to the model
  if (a.verb === 'close') return 'change';
  if (a.verb === 'launch') return 'change';
  if (a.verb === 'press') {
    // Return/Enter often submits a form or sends a message.
    if (/^(return|enter|cmd\+return|ctrl\+return|cmd\+enter|ctrl\+enter)$/i.test(a.value ?? '')) return 'sensitive';
    if (/^(cmd|ctrl)\+(backspace|delete|d|w|q)$/i.test(a.value ?? '') || /^shift\+delete$/i.test(a.value ?? '')) return 'sensitive';
    return 'change';
  }
  if (a.target && hasWord(`${a.target.name}`, SENSITIVE_WORDS) && ['click', 'double-click', 'press', 'toggle', 'check', 'select'].includes(a.verb)) return 'sensitive';
  if (a.target && /password|secure/i.test(a.target.role)) return 'sensitive';
  return 'change';
}

export function isBlocked(app: string | undefined, blocked: string[]): boolean {
  if (!app) return false;
  const a = app.toLowerCase();
  return blocked.some((b) => a === b.toLowerCase() || a.includes(b.toLowerCase()));
}
