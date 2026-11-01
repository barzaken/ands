import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Gate, answerRemote, serveRemote, withRemoteOk, relayDesk, type Ask } from '../src/index.ts';

process.env.ANDS_HOME = `${process.env.TMPDIR ?? '/tmp'}/ands-remote-test-${process.pid}`;

const engine = () => new Engine(async (args) => args[0] === 'snapshot'
  ? { ok: true, data: { tree: { role: 'window', name: 'Mail', children: [{ role: 'button', name: 'Send', ref_id: '@s:e1' }] } } }
  : { ok: true, data: {} });

test('a remote agent’s sensitive click asks the person on this computer, and a no stops it', async () => {
  const asked: Ask[] = [];
  const e = engine();
  const gate = new Gate({ approver: async (a) => (asked.push(a), 'no') });
  await answerRemote({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ands_look', arguments: { app: 'Mail' } } }, { engine: e, gate });
  const r: any = await answerRemote({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ands_act', arguments: { action: 'click', ref: '@s:e1', why: 'send it' } } }, { engine: e, gate });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.tier, 'sensitive');
  assert.equal(r.result.isError, true);
  const list: any = await answerRemote({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { engine: e, gate });
  assert.ok(list.result.tools.every((t: any) => t.name !== 'ands_do'));
  const bad: any = await answerRemote({ jsonrpc: '2.0', id: 4, method: 'elicitation/create' }, { engine: e, gate });
  assert.equal(bad.error.code, -32601);
});

test('the loop takes calls, answers them in order, and stops when the link is revoked', async () => {
  const pushed: any[] = [];
  let pulls = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    assert.equal((init.headers as any).authorization, 'Bearer sec');
    if (url.endsWith('/relay/pull/L1')) {
      pulls++;
      if (pulls === 1) return new Response(JSON.stringify({ calls: [{ id: 7, request: { jsonrpc: '2.0', id: 'a', method: 'tools/list' } }, { id: 8, request: { jsonrpc: '2.0', id: 'b', method: 'ping' } }] }));
      return new Response('{}', { status: 401 });
    }
    if (url.endsWith('/relay/push/L1')) { pushed.push(JSON.parse(String(init.body))); return new Response('{"ok":true}'); }
    throw new Error(url);
  }) as typeof fetch;
  const states: string[] = [];
  await serveRemote({ base: 'https://cloud/functions/v1/', link: { id: 'L1', computerSecret: 'sec' }, engine: engine(), gate: new Gate({ approver: async () => 'no' }), fetch: fetchFn, onState: (s) => states.push(s) });
  assert.deepEqual(pushed.map((p) => [p.id, p.response.id]), [[7, 'a'], [8, 'b']]);
  assert.deepEqual(states, ['online', 'revoked']);
});

/** An in-memory stand-in for the relay's approval endpoints; `answer` is what the person taps on the phone. */
function desk() {
  const rows = new Map<string, { fingerprint: string; state: string }>();
  let n = 0;
  return {
    rows,
    answer(state: string) { for (const r of rows.values()) r.state = state; },
    async create(o: any) { for (const [id, r] of rows) if (r.fingerprint === o.fingerprint && r.state === 'pending') return { id, url: `https://ands.sh/ok/${id}` }; const id = `ok${++n}`; rows.set(id, { fingerprint: o.fingerprint, state: 'pending' }); return { id, url: `https://ands.sh/ok/${id}` }; },
    async state(id: string, fp: string) { const r = rows.get(id); return (r && r.fingerprint === fp ? r.state : 'expired') as any; },
  };
}
const never = () => new Promise<never>(() => {});

test('nobody answers in time: the agent gets the phone link, and its retry runs after the person taps yes', async () => {
  const d = desk();
  const e = engine();
  const gate = new Gate({ approver: async () => 'no' });
  gate.approver = withRemoteOk(never, { desk: d, gate, waitMs: 30, pollMs: 5 });
  await answerRemote({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ands_look', arguments: { app: 'Mail' } } }, { engine: e, gate });
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ands_act', arguments: { action: 'click', ref: '@s:e1', why: 'send it' } } };
  const first: any = await answerRemote(call, { engine: e, gate });
  assert.equal(first.result.isError, true);
  assert.match(first.result.content[0].text, /https:\/\/ands\.sh\/ok\/ok1/);
  d.answer('yes');
  const again: any = await answerRemote({ ...call, id: 3 }, { engine: e, gate });
  assert.equal(again.result.isError, false);
  assert.equal(d.rows.size, 1);
});

test('the phone and the computer race: whoever answers first counts, and the computer card is dismissed', async () => {
  const d = desk();
  const gate = new Gate({ approver: async () => 'no' });
  let dismissed = 0;
  const ask = { action: { verb: 'click', target: { role: 'button', name: 'Send' } }, tier: 'sensitive' as const };
  const phoneFirst = withRemoteOk(never, { desk: d, gate, waitMs: 1000, pollMs: 5, dismiss: () => dismissed++ });
  // The person taps yes once the phone request exists (on a slow machine it can take longer than a fixed delay).
  const tap = setInterval(() => { if (d.rows.size) { d.answer('yes'); clearInterval(tap); } }, 5);
  assert.equal(await phoneFirst(ask), 'yes');
  assert.equal(dismissed, 1);
  const hereFirst = withRemoteOk(async () => 'no', { desk: desk(), gate, waitMs: 1000, pollMs: 5 });
  assert.equal(await hereFirst(ask), 'no');
});

test('the relay desk sends the computer secret and ignores an answer for a different step', async () => {
  const f = (async (url: string, init: RequestInit = {}) => {
    assert.equal((init.headers as any).authorization, 'Bearer sec');
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'A', url: 'https://ands.sh/ok/A', state: 'pending' }));
    return new Response(JSON.stringify({ id: 'A', state: 'yes', fingerprint: 'other' }));
  }) as typeof fetch;
  const d = relayDesk('https://cloud/functions/v1/', { id: 'L1', computerSecret: 'sec' }, f);
  assert.equal((await d.create({ fingerprint: 'fp', text_he: 'x', text_en: 'x', tier: 'sensitive' })).url, 'https://ands.sh/ok/A');
  assert.equal(await d.state('A', 'fp'), 'expired');
  assert.equal(await d.state('A', 'other'), 'yes');
});
