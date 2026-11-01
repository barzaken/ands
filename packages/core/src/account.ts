// The person's ands account on our Supabase project, for the desktop app and the CLI alike:
// sign in with a code sent by email (Supabase Auth), keep the session fresh, read the plan and
// minutes left (my_account), and send model turns to the `chat` edge function, which holds the
// model key. No Node APIs, so the app window runs it too.

/** The ands Supabase project. The anon key is public by design; the database's RLS keeps rows private. */
export const SUPABASE_URL = (globalThis as any).process?.env?.ANDS_SUPABASE_URL ?? 'https://ttbajovuuovhckflivfl.supabase.co';
export const SUPABASE_ANON_KEY: string = (globalThis as any).process?.env?.ANDS_SUPABASE_ANON_KEY ?? 'sb_publishable_2b7xblY9JyDjZIXl5_n-Zw_yqgZ9hVG';
export const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat`;

export type Session = { access: string; refresh: string; exp: number };
export type Me = { email: string; subscribed: boolean; minutesLeft: number; checkoutUrl: string | null; termsVersion?: string | null };
/** The Terms of Use version the app asks people to accept (ands.sh/terms). */
export const TERMS_VERSION = '2026-10-31';
type Lang = 'he' | 'en';

/** Headers for any call to the ands Supabase project as this person (REST, RPC, edge functions). */
export const authHeaders = (s?: Session): Record<string, string> => ({ apikey: SUPABASE_ANON_KEY, ...(s ? { authorization: `Bearer ${s.access}` } : {}) });

const T = {
  he: { badCode: 'הקוד לא נכון או שפג תוקפו. נסו לבקש קוד חדש.', badEmail: 'כתובת המייל לא נראית תקינה.', busy: 'השירות עמוס כרגע. נסו שוב בעוד רגע.', tooMany: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' },
  en: { badCode: 'That code is wrong or expired. Ask for a new one.', badEmail: 'That email address does not look right.', busy: 'The service is busy. Try again in a moment.', tooMany: 'Too many tries. Try again in a few minutes.' },
};

async function call(path: string, body: object | undefined, lang: Lang, token?: string) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 429 ? T[lang].tooMany : res.status === 400 || res.status === 403 || res.status === 401 ? (path.includes('otp') ? T[lang].badEmail : T[lang].badCode) : T[lang].busy;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return out;
}

const toSession = (o: any): Session => ({ access: o.access_token, refresh: o.refresh_token, exp: (o.expires_at ?? Date.now() / 1000 + (o.expires_in ?? 3600)) * 1000 });

/** Step 1: email a code. New emails get an account on the spot. */
export async function requestCode(email: string, lang: Lang): Promise<void> {
  await call('/auth/v1/otp', { email: email.trim().toLowerCase(), create_user: true }, lang);
}

/** Step 2: the code from the email becomes a session. */
export async function verifyCode(email: string, code: string, lang: Lang): Promise<Session> {
  return toSession(await call('/auth/v1/verify', { type: 'email', email: email.trim().toLowerCase(), token: code.replace(/\D/g, '') }, lang));
}

/** A session good for at least five more minutes, refreshing it when needed. Throws 401 when it is gone. */
export async function fresh(s: Session, lang: Lang): Promise<Session> {
  if (s.exp - Date.now() > 5 * 60_000) return s;
  return toSession(await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh }, lang));
}

export async function whoAmI(s: Session, lang: Lang): Promise<Me> {
  return call('/rest/v1/rpc/my_account', {}, lang, s.access);
}

/** Records that this person accepted the Terms (continuing at sign-up counts as acceptance). */
export async function acceptTerms(s: Session, lang: Lang, version = TERMS_VERSION): Promise<void> {
  await call('/rest/v1/rpc/accept_terms', { p_version: version }, lang, s.access);
}

/** Records that this person confirmed the autopilot warning, each time they turn autopilot on. */
export async function consentAutopilot(s: Session, lang: Lang): Promise<void> {
  await call('/rest/v1/rpc/consent_autopilot', {}, lang, s.access);
}

/** A fetch for the chat function that adds our headers and reports the minutes left after each turn. */
export function accountFetch(lang: Lang, onMinutes: (m: number) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('x-ands-lang', lang);
    headers.set('apikey', SUPABASE_ANON_KEY);
    const res = await fetch(input, { ...init, headers });
    res.clone().json().then((b: any) => { if (typeof b?.ands?.minutesLeft === 'number') onMinutes(b.ands.minutesLeft); }).catch(() => {});
    return res;
  }) as typeof fetch;
}
