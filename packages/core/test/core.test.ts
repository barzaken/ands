import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, Gate, Engine, collectRefs, runTool, type Ask, type Envelope } from '../src/index.ts';

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
  g.planApproved = true;
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

test('yes_for_task stops asking about changes for the rest of the task', async () => {
  const r = recorder('yes_for_task');
  const g = new Gate({ approver: r.approver });
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
