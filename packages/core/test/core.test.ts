import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, Gate, Engine, collectRefs, runTool, describe, serial, agentId, type Ask, type Envelope } from '../src/index.ts';

process.env.ANDS_HOME = `${process.env.TMPDIR ?? '/tmp'}/ands-test-${process.pid}`;

test('reads go through, ordinary clicks are changes, send/pay/delete words are sensitive', () => {
  assert.equal(classify({ verb: 'look' }), 'read');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'Downloads' } }), 'change');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'Send' } }), 'sensitive');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'Sender settings' } }), 'change');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'שליחה' } }), 'sensitive');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'לשלם עכשיו' } }), 'sensitive');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'Move to Trash' } }), 'sensitive');
  assert.equal(classify({ verb: 'press', value: 'return' }), 'sensitive');
  assert.equal(classify({ verb: 'press', value: 'cmd+c' }), 'change');
  assert.equal(classify({ verb: 'clipboard_get' }), 'sensitive');
});

const recorder = (answer: 'yes' | 'no' | 'yes_for_task') => {
  const asked: Ask[] = [];
  return { asked, approver: async (a: Ask) => (asked.push(a), answer) };
};

test('an approved plan covers changes but never sensitive steps', async () => {
  const r = recorder('yes');
  const g = new Gate({ approver: r.approver });
  g.startTask('t');
  g.planApproved = true;
  assert.equal((await g.check({ verb: 'click', target: { role: 'button', name: 'Open' } })).allowed, true);
  assert.equal(r.asked.length, 0);
  await g.check({ verb: 'click', target: { role: 'button', name: 'Delete' } });
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].tier, 'sensitive');
});

test('ask_all asks for every change; a no blocks it; blocked apps are refused without asking', async () => {
  const r = recorder('no');
  const g = new Gate({ approver: r.approver, trust: 'ask_all' });
  const v = await g.check({ verb: 'click', target: { role: 'button', name: 'Open' } });
  assert.equal(v.allowed, false);
  assert.equal(r.asked.length, 1);
  const b = await g.check({ verb: 'click', app: '1Password 8' });
  assert.equal(b.allowed, false);
  assert.equal(r.asked.length, 1);
});

test('autopilot asks nothing, even for sensitive steps, but blocked apps stay blocked', async () => {
  const r = recorder('no');
  const g = new Gate({ approver: r.approver, trust: 'autopilot' });
  assert.equal((await g.check({ verb: 'click', target: { role: 'button', name: 'Send' } })).allowed, true);
  assert.equal((await g.check({ verb: 'press', value: 'return' })).allowed, true);
  assert.equal((await g.check({ verb: 'click', app: '1Password 8' })).allowed, false);
  assert.equal(r.asked.length, 0);
});

test('ask_important asks only sensitive steps, even with no plan (an outside agent)', async () => {
  const r = recorder('yes');
  const g = new Gate({ approver: r.approver });
  await g.check({ verb: 'click', target: { role: 'link', name: 'YouTube' } });
  await g.check({ verb: 'type', value: 'lofi' });
  assert.equal(r.asked.length, 0);
  await g.check({ verb: 'click', target: { role: 'button', name: 'Send' } });
  assert.equal(r.asked.length, 1);
});

test('yes_for_task stops asking about changes for the rest of the task', async () => {
  const r = recorder('yes_for_task');
  const g = new Gate({ approver: r.approver, trust: 'ask_all' });
  await g.check({ verb: 'click' });
  await g.check({ verb: 'type', value: 'x' });
  assert.equal(r.asked.length, 1);
});

const TREE = { role: 'window', name: 'Mail', children: [{ role: 'button', name: 'Send', ref_id: '@s1:e1' }, { role: 'textfield', name: 'Subject', ref_id: '@s1:e2' }] };

function fakeEngine(calls: string[][]) {
  return new Engine(async (args): Promise<Envelope> => {
    calls.push(args);
    if (args[0] === 'snapshot') return { ok: true, command: 'snapshot', data: { snapshot_id: 's1', tree: TREE } };
    return { ok: true, command: args[0], data: { done: true } };
  });
}

test('refs from a look let the gate see that a click hits "Send"', async () => {
  const calls: string[][] = [];
  const engine = fakeEngine(calls);
  assert.equal(collectRefs(TREE).get('@s1:e1')?.name, 'Send');
  const r = recorder('no');
  const gate = new Gate({ approver: r.approver });
  gate.planApproved = true;
  await runTool('ands_look', { app: 'Mail' }, { engine, gate, source: 'test' });
  const typed = await runTool('ands_act', { action: 'type', ref: '@s1:e2', value: 'Hi', why: 'subject' }, { engine, gate, source: 'test' });
  assert.equal(typed.ok, true);
  const sent = await runTool('ands_act', { action: 'click', ref: '@s1:e1', why: 'send it' }, { engine, gate, source: 'test' });
  assert.equal(sent.ok, false);
  assert.equal(r.asked[0].tier, 'sensitive');
  assert.deepEqual(calls.map((c) => c[0]), ['snapshot', 'type']);
});

test('the desktop engine puts headed and session flags before every command, and errors carry their details', async () => {
  const seen: string[][] = [];
  const engine = new Engine(async (args) => {
    seen.push(args);
    return { ok: false, error: { code: 'AMBIGUOUS_TARGET', message: 'Several windows', details: { candidates: ['w-1', 'w-2'] } } };
  }, ['--headed', '--session', 's1']);
  const gate = new Gate({ trust: 'autopilot', approver: async () => 'yes' });
  const r = await runTool('ands_look', { app: 'Finder' }, { engine, gate, source: 'test' });
  assert.deepEqual(seen[0].slice(0, 4), ['--headed', '--session', 's1', 'snapshot']);
  assert.equal(r.ok, false);
  assert.match(r.text, /w-1/);
});

test('pointTo moves the pointer onto the element only after the gate allowed the action', async () => {
  const seen: string[] = [];
  const engine = new Engine(async (args) => { seen.push(args.join(' ')); return { ok: true, data: {} }; }, [], { pointTo: true });
  const no = new Gate({ trust: 'ask_all', approver: async () => 'no' });
  await runTool('ands_act', { action: 'select', ref: '@s:e1', value: 'a.png', why: 'x' }, { engine, gate: no, source: 'test' });
  assert.deepEqual(seen, []);
  const yes = new Gate({ trust: 'ask_all', approver: async () => 'yes' });
  await runTool('ands_act', { action: 'select', ref: '@s:e1', value: 'a.png', why: 'x' }, { engine, gate: yes, source: 'test' });
  assert.deepEqual(seen, ['hover @s:e1', 'select @s:e1 a.png']);
});

test('Hebrew words count only as whole words: a film title or "Hebrew" is not a delete or a transfer', () => {
  assert.equal(classify({ verb: 'click', target: { role: 'link', name: 'הסרט החדש של השנה' } }), 'change');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'עברית' } }), 'change');
  assert.equal(classify({ verb: 'click', target: { role: 'link', name: 'כאשר נפגשנו' } }), 'change');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'הסרה' } }), 'sensitive');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'ולמחוק' } }), 'sensitive');
  assert.equal(classify({ verb: 'click', target: { role: 'button', name: 'אישור' } }), 'sensitive');
});

test('Return after typing into a search field is a change; in a message box it still asks', async () => {
  assert.equal(classify({ verb: 'press', value: 'return', target: { role: 'combobox', name: 'Search' } }), 'change');
  assert.equal(classify({ verb: 'press', value: 'return', target: { role: 'textfield', name: 'חיפוש' } }), 'change');
  assert.equal(classify({ verb: 'press', value: 'return', target: { role: 'textarea', name: 'Search messages' } }), 'sensitive');
  assert.equal(classify({ verb: 'press', value: 'return', target: { role: 'textfield', name: 'Type a message' } }), 'sensitive');
  assert.equal(classify({ verb: 'press', value: 'cmd+return', target: { role: 'combobox', name: 'Search' } }), 'sensitive');
  // Through the tools: the field comes from the screen, and only the field typed into last.
  const engine = new Engine(async (args) => ({ ok: true, data: args[0] === 'snapshot' ? { tree: { ref_id: '@s:e1', role: 'combobox', name: 'Search', children: [{ ref_id: '@s:e2', role: 'textarea', name: 'Message' }] } } : {} }));
  const { asked, approver } = recorder('yes');
  const gate = new Gate({ trust: 'ask_all', approver });
  await runTool('ands_look', { app: 'Google Chrome' }, { engine, gate, source: 'test' });
  await runTool('ands_act', { action: 'type', ref: '@s:e1', value: 'lofi', why: 'x' }, { engine, gate, source: 'test' });
  await runTool('ands_press', { combo: 'return', why: 'x' }, { engine, gate, source: 'test' });
  assert.deepEqual(asked.map((a) => a.tier), ['change', 'change']);
  await runTool('ands_press', { combo: 'return', why: 'x' }, { engine, gate, source: 'test' });
  assert.equal(asked.at(-1)!.tier, 'sensitive');
});

test('look with text finds elements and remembers their refs for the gate', async () => {
  const seen: string[][] = [];
  const engine = new Engine(async (args) => { seen.push(args); return { ok: true, data: { matches: [{ ref_id: '@f:e3', role: 'button', name: 'Download' }] } }; });
  const gate = new Gate({ trust: 'autopilot', approver: async () => 'yes' });
  const r = await runTool('ands_look', { app: 'Google Chrome', text: 'Download', role: 'button' }, { engine, gate, source: 'test' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0], ['find', '--text', 'Download', '--limit', '20', '--app', 'Google Chrome', '--role', 'button']);
  assert.deepEqual(engine.refs.get('@f:e3'), { role: 'button', name: 'Download' });
});

test('file actions: listing reads, the Trash always asks, the rest are changes', async () => {
  assert.equal(classify({ verb: 'files_list' }), 'read');
  assert.equal(classify({ verb: 'files_trash', value: '200 files' }), 'sensitive');
  for (const verb of ['files_search', 'computer_info']) assert.equal(classify({ verb }), 'read');
  for (const verb of ['files_empty_trash', 'files_download']) assert.equal(classify({ verb }), 'sensitive');
  for (const verb of ['files_rename', 'files_organize', 'files_zip', 'files_unzip', 'files_images', 'computer_volume', 'computer_dark_mode', 'computer_screenshot', 'computer_settings']) assert.equal(classify({ verb }), 'change');
  for (const verb of ['files_move', 'files_copy', 'files_mkdir', 'files_open', 'open_url']) assert.equal(classify({ verb }), 'change');
  const asked: string[] = [];
  const gate = new Gate({ approver: async (a) => { asked.push(a.action.verb); return 'no'; } });
  assert.equal((await gate.check({ verb: 'files_move', value: 'a.png → Shots' })).allowed, true);
  assert.equal((await gate.check({ verb: 'files_trash', value: 'a.png' })).allowed, false);
  assert.deepEqual(asked, ['files_trash']);
  assert.match(describe({ verb: 'files_trash', value: '3 files' }, 'he'), /לפח/);
});

test('in the background a step that needs real input runs again headed, one agent at a time', async () => {
  const seen: string[] = [];
  let inside = 0, most = 0;
  const run = async (args: string[]): Promise<Envelope> => {
    seen.push(args.join(' '));
    if (!args.includes('--headed')) return { ok: false, error: { code: 'POLICY_DENIED', message: 'needs --headed', disposition: { retry: 'safe' } } };
    inside++; most = Math.max(most, inside);
    await new Promise((r) => setTimeout(r, 5));
    inside--;
    return { ok: true, data: {} };
  };
  const hands = serial();
  const a = new Engine(run, ['--session', 's', '--agent-id', 'a'], { hands, background: true });
  const b = new Engine(run, ['--session', 's', '--agent-id', 'b'], { hands, background: true });
  const [x, y] = await Promise.all([a.press('return', 'Safari'), b.act('type', '@s:e1', 'hi')]);
  assert.ok(x.ok && y.ok);
  assert.equal(most, 1);
  assert.ok(seen.includes('--session s --agent-id a --headed press return --app Safari'));
  assert.ok(seen.includes('--session s --agent-id b --headed type @s:e1 hi'));
  // A refusal for another reason is not retried, and a lone agent without hands never goes headed.
  const plain = new Engine(run);
  assert.equal((await plain.press('return')).ok, false);
  assert.ok(!seen.includes('--headed press return'));
});

test('agent names become engine agent ids', () => {
  assert.equal(agentId('mail pdfs!'), 'mail-pdfs');
  assert.match(agentId('מייל'), /^agent-[a-z0-9]+$/);
  assert.notEqual(agentId('מייל'), agentId('קבצים'));
  assert.equal(agentId(undefined), 'main');
  assert.equal(agentId('x'.repeat(80)).length, 64);
});
