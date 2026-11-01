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
  'שלח', 'שלוח', 'שליחה', 'פרסם', 'שתף', 'השב', 'הגש',
  'שלם', 'תשלום', 'קנה', 'רכישה', 'הזמן', 'הזמנה', 'העבר', 'העברה', 'תרום',
  'מחק', 'מחוק', 'מחיקה', 'הסר', 'הסרה', 'רוקן', 'אפס', 'התקן', 'התקנה', 'אשרו', 'אישור', 'התחבר', 'הרשמה', 'הסכם', 'מסכים',
];

/** Apps ands never touches unless the person removes them from this list. */
export const DEFAULT_BLOCKED_APPS = ['1Password', 'Bitwarden', 'Keychain Access', 'LastPass', 'KeePassXC'];

const hasWord = (text: string, words: string[]) => {
  const t = ` ${text.toLowerCase()} `;
  return words.some((w) => {
    const i = t.indexOf(w);
    if (i < 0) return false;
    // A Latin word must stand alone ("send" yes, "sender" no).
    if (/[a-z]/.test(w)) return !/[a-z]/.test(t[i - 1] ?? ' ') && !/[a-z]/.test(t[i + w.length] ?? ' ');
    // A Hebrew word may carry up to two prefix letters (ו, ה, ל, ב, מ, כ, ש) and a short ending, but must not sit
    // inside another word: "הסרה" and "ולמחוק" yes, "הסרט" (a film) and "העברית" no.
    return hebrewWord(w).test(t);
  });
};
const HE = 'א-ת';
const hebrewWord = (w: string) => new RegExp(`(^|[^${HE}])[ובלמכשה]{0,2}${w}(ה|ו|י|ים|ות|ת|נו|תי)?($|[^${HE}])`);

export function classify(a: Action): Tier {
  if (READ.has(a.verb)) return 'read';
  // The desktop app's own background actions (no terminal): listing, searching and reading the computer's
  // state are reads; the rest (folders, moving, renaming, zip, images, settings, volume) are changes.
  if (['files_list', 'files_search', 'computer_info'].includes(a.verb)) return 'read';
  // Moving to or emptying the Trash, and downloading from the internet, always ask.
  if (['files_trash', 'files_empty_trash', 'files_download'].includes(a.verb)) return 'sensitive';
  if (/^(files|computer)_/.test(a.verb) || a.verb === 'open_url') return 'change';
  if (a.verb === 'clipboard_get' || a.verb === 'screenshot') return 'sensitive'; // can expose private content to the model
  if (a.verb === 'close') return 'change';
  if (a.verb === 'launch') return 'change';
  if (a.verb === 'press') {
    // Return/Enter often submits a form or sends a message.
    // Return in a search or address field only searches or opens a page; anywhere else it may send or submit.
    // The field is the one ands last typed into, as the screen names it.
    if (/^(return|enter)$/i.test(a.value ?? '') && a.target && isSearchField(a.target)) return 'change';
    if (/^(return|enter|cmd\+return|ctrl\+return|cmd\+enter|ctrl\+enter)$/i.test(a.value ?? '')) return 'sensitive';
    if (/^(cmd|ctrl)\+(backspace|delete|d|w|q)$/i.test(a.value ?? '') || /^shift\+delete$/i.test(a.value ?? '')) return 'sensitive';
    return 'change';
  }
  if (a.target && hasWord(`${a.target.name}`, SENSITIVE_WORDS) && ['click', 'double-click', 'press', 'toggle', 'check', 'select'].includes(a.verb)) return 'sensitive';
  if (a.target && /password|secure/i.test(a.target.role)) return 'sensitive';
  return 'change';
}

/** A one-line search or address field. A multi-line box (where messages are written) never counts. */
export function isSearchField(t: { role: string; name: string }): boolean {
  if (/area|document|editor|group/i.test(t.role)) return false;
  if (/search/i.test(t.role)) return true;
  return /textfield|combobox|textbox|text field|edit/i.test(t.role) && hasSearchName(t.name);
}
const hasSearchName = (name: string) => /\b(search|find|address|url|go to)\b/i.test(name) || /(חיפוש|חפש|כתובת)/.test(name);

export function isBlocked(app: string | undefined, blocked: string[]): boolean {
  if (!app) return false;
  const a = app.toLowerCase();
  return blocked.some((b) => a === b.toLowerCase() || a.includes(b.toLowerCase()));
}
