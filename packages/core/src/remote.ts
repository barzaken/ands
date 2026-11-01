// Remote agents: a cloud agent (lvlz, or any agent that adds an MCP server by URL) drives this
// computer through the ands relay (cloud/relay). This is the computer's side: pair once to get a link,
// then serve it. It uses fetch only, so the CLI and the desktop app's webview both run it.
//
// The safety line stays here, on the computer: every call goes through runTool, so Gate.check runs
// before the engine, and approvals go to the host's own approver (the app's approve card, or the
// terminal). The remote agent can never answer an approval, because nothing in this loop asks it.
import type { Engine } from './engine.ts';
import { describe, type Gate, type Approver, type Ask, type Answer } from './gate.ts';
import type { Action } from './policy.ts';
import { TOOLS, runTool } from './tools.ts';

type Fetch = typeof fetch;

/** A link as the relay returns it on pairing. `agentUrl` carries the agent's secret; `token` is the same secret for agents that want a header. */
export type RemoteLink = { id: string; name: string; agentUrl: string; token: string; computerSecret: string };
/** What the computer keeps to serve a link. */
export type RemoteCreds = { id: string; computerSecret: string };
export type RemoteState = 'online' | 'offline' | 'revoked';
export type RemoteCall = { tool: string; input: any; ok: boolean; text: string };

/**
 * Where the relay lives: the ands-cloud functions base, e.g. https://<project>.supabase.co/functions/v1.
 * `headers` are the signed-in person's Supabase headers (apikey + authorization), from account.ts.
 */
export type CloudAuth = { base: string; headers: Record<string, string>; fetch?: Fetch };

async function call(auth: CloudAuth, path: string, init: RequestInit = {}) {
  const res = await (auth.fetch ?? fetch)(`${auth.base.replace(/\/$/, '')}${path}`, { ...init, headers: { 'content-type': 'application/json', ...auth.headers, ...(init.headers ?? {}) } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `relay ${res.status}`);
  return body;
}

/** Create a link for an agent. Show `agentUrl` once (with a copy button); keep `id` and `computerSecret`. */
export const pair = (auth: CloudAuth, name = 'agent'): Promise<RemoteLink> => call(auth, '/relay-link', { method: 'POST', body: JSON.stringify({ name }) });
export const listLinks = async (auth: CloudAuth): Promise<{ id: string; name: string; created_at: string; last_seen: string | null }[]> => (await call(auth, '/relay-link')).links;
export const revokeLink = (auth: CloudAuth, id: string) => call(auth, `/relay-link?id=${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---- Approving from a distance --------------------------------------------------------------
// The person may be away from this computer (it is at work, they are on WhatsApp with their agent).
// A step that needs an OK then gets a one-time link, ands.sh/ok/<id>, that only the signed-in owner of
// this link can answer. The agent only carries the link; nothing it sends can approve a step.

/** Thrown by the approver when nobody answered in time: the agent gets the link to pass on. */
export class NeedsOk extends Error {
  url: string;
  what: string;
  constructor(url: string, what: string) { super(`needs the person's OK: ${url}`); this.url = url; this.what = what; }
}

/** A stable id for "this exact step", so the agent's retry finds the answer the person gave. */
export async function fingerprint(a: Action): Promise<string> {
  const text = JSON.stringify([a.verb, a.app ?? '', a.ref ?? '', a.target?.role ?? '', a.target?.name ?? '', a.value ?? '']);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type OkState = 'pending' | 'yes' | 'no' | 'expired';
/** The relay's approval endpoints, as the computer uses them. `state` must answer for the same step (fingerprint). */
export type OkDesk = {
  create(o: { fingerprint: string; text_he: string; text_en: string; tier: string }): Promise<{ id: string; url: string }>;
  state(id: string, fingerprint: string): Promise<OkState>;
};

export function relayDesk(base: string, link: RemoteCreds, f: Fetch = fetch): OkDesk {
  const url = (rest: string) => `${base.replace(/\/$/, '')}/relay/approval/${link.id}${rest}`;
  const headers = { authorization: `Bearer ${link.computerSecret}`, 'content-type': 'application/json' };
  return {
    async create(o) {
      const res = await f(url(''), { method: 'POST', headers, body: JSON.stringify(o) });
      if (!res.ok) throw new Error(`approval ${res.status}`);
      return (await res.json()) as { id: string; url: string };
    },
    async state(id, fp) {
      const res = await f(url(`/${encodeURIComponent(id)}`), { headers });
      if (!res.ok) return 'expired';
      const b: any = await res.json();
      // An answer only counts for the exact step it was asked about.
      if (b?.fingerprint !== fp) return 'expired';
      return (['pending', 'yes', 'no', 'expired'].includes(b.state) ? b.state : 'expired') as OkState;
    },
  };
}

/**
 * Wraps the computer's own approver: the question shows on this computer AND as a phone link at the
 * same time, and whichever the person answers first counts. If neither is answered within `waitMs`,
 * it throws NeedsOk so the agent can send the link; the agent's retry of the same step gets the answer.
 * "Yes to all" on the computer covers ordinary steps for `allForMs`, never sensitive ones (the phone page answers one step).
 */
export function withRemoteOk(local: Approver, o: {
  desk: OkDesk; gate: Gate; dismiss?: () => void; waitMs?: number; pollMs?: number; allForMs?: number;
}): Approver {
  const open = new Map<string, { id: string; url: string }>();
  let allUntil = 0;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settle = (a: Answer): Answer => {
    if (a === 'yes_for_task') { allUntil = Date.now() + (o.allForMs ?? 30 * 60_000); setTimeout(() => { if (Date.now() >= allUntil) o.gate.planApproved = false; }, (o.allForMs ?? 30 * 60_000) + 50); }
    return a;
  };
  return async (ask: Ask): Promise<Answer> => {
    const fp = await fingerprint(ask.action);
    const fromState = (st: OkState): Answer | undefined => (st === 'yes' ? 'yes' : st === 'no' ? 'no' : undefined);
    let req = open.get(fp);
    if (req) {
      const st = await o.desk.state(req.id, fp).catch((): OkState => 'pending');
      const a = fromState(st);
      if (a) { open.delete(fp); return settle(a); }
      if (st === 'expired') { open.delete(fp); req = undefined; }
    }
    if (!req) {
      req = await o.desk.create({ fingerprint: fp, text_he: describe(ask.action, 'he'), text_en: describe(ask.action, 'en'), tier: ask.tier });
      open.set(fp, req);
    }
    const id = req.id;
    let done = false;
    const phone = (async (): Promise<Answer | 'timeout'> => {
      const end = Date.now() + (o.waitMs ?? 25_000);
      while (!done && Date.now() < end) {
        await pause(o.pollMs ?? 2000);
        const a = fromState(await o.desk.state(id, fp).catch((): OkState => 'pending'));
        if (a) return a;
      }
      return 'timeout';
    })();
    const here = local(ask).then((a) => ({ here: a }));
    const first = await Promise.race([here, phone.then((p) => ({ phone: p }))]);
    done = true;
    if ('here' in first) { open.delete(fp); return settle(first.here); }
    o.dismiss?.();
    if (first.phone === 'timeout') throw new NeedsOk(req.url, describe(ask.action, 'en'));
    open.delete(fp);
    return settle(first.phone);
  };
}

/** One MCP message from the agent, answered on this computer. The relay answers initialize and ping itself. */
export async function answerRemote(msg: any, ctx: { engine: Engine; gate: Gate; onCall?: (c: RemoteCall) => void }): Promise<object> {
  const reply = (result: object) => ({ jsonrpc: '2.0', id: msg?.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
  switch (msg?.method) {
    case 'tools/list': return reply({ tools: TOOLS });
    case 'ping': return reply({});
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool ${name}`);
      ctx.gate.task ??= 'remote agent';
      let r;
      try { r = await runTool(name, args, { engine: ctx.engine, gate: ctx.gate, source: 'remote' }); }
      catch (e) {
        if (!(e instanceof NeedsOk)) throw e;
        const text = `Not done yet: this step needs the person's OK (${e.what}). Send them this link so they can approve it from their phone: ${e.url}\nWhen they have answered, call ${name} again with the same arguments. If they had to sign in first, the link may ask for a fresh one: call ${name} again and send the new link. Do not open the link yourself; only the person can answer it.`;
        ctx.onCall?.({ tool: name, input: args, ok: false, text });
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
      ctx.onCall?.({ tool: name, input: args, ok: r.ok, text: r.text });
      const content: any[] = [{ type: 'text', text: r.text }];
      if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
      return reply({ content, isError: !r.ok });
    }
    default: return fail(-32601, `Method not found: ${msg?.method}`);
  }
}

/**
 * Keep the computer connected until `signal` aborts or the link is revoked: long-poll the relay for
 * the agent's calls, answer each one here, and post the answer back. Calls run one at a time, in order,
 * so an approval question never overlaps another action.
 */
export async function serveRemote(o: {
  base: string; link: RemoteCreds; engine: Engine; gate: Gate; signal?: AbortSignal; fetch?: Fetch;
  onCall?: (c: RemoteCall) => void; onState?: (s: RemoteState) => void; retryMs?: number;
  /** Also offer each question as a phone link (default on). `dismiss` hides the computer's card when the phone answered first. */
  phoneOk?: boolean; dismiss?: () => void; waitMs?: number;
}): Promise<void> {
  const f = o.fetch ?? fetch;
  if (o.phoneOk !== false) o.gate.approver = withRemoteOk(o.gate.approver, { desk: relayDesk(o.base, o.link, f), gate: o.gate, dismiss: o.dismiss, waitMs: o.waitMs });
  const url = (kind: string) => `${o.base.replace(/\/$/, '')}/relay/${kind}/${o.link.id}`;
  const headers = { authorization: `Bearer ${o.link.computerSecret}`, 'content-type': 'application/json' };
  let state: RemoteState | undefined;
  const set = (s: RemoteState) => { if (s !== state) { state = s; o.onState?.(s); } };
  const pause = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); o.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  while (!o.signal?.aborted) {
    let calls: { id: number; request: any }[] = [];
    try {
      const res = await f(url('pull'), { method: 'POST', headers, body: '{}', signal: o.signal });
      if (res.status === 401) { set('revoked'); return; }
      if (!res.ok) throw new Error(String(res.status));
      calls = ((await res.json()) as any).calls ?? [];
      set('online');
    } catch {
      if (o.signal?.aborted) return;
      set('offline');
      await pause(o.retryMs ?? 3000);
      continue;
    }
    for (const c of calls) {
      if (o.signal?.aborted) return;
      let response: object;
      try { response = await answerRemote(c.request, o); } catch (e: any) { response = { jsonrpc: '2.0', id: c.request?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }; }
      await f(url('push'), { method: 'POST', headers, body: JSON.stringify({ id: c.id, response }) }).catch(() => {});
    }
  }
}
