import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer, clientConfig } from '../src/mcp.ts';

process.env.ANDS_HOME = `${process.env.TMPDIR ?? '/tmp'}/ands-mcp-test-${process.pid}`;

const engine = (seen: string[][] = []) => async (args: string[]) => {
  seen.push(args);
  const cmd = args.find((a) => ['session', 'snapshot', 'cursor-overlay'].includes(a));
  if (cmd === 'session') return { ok: true, data: { session_id: 'run-1' } };
  return cmd === 'snapshot'
    ? { ok: true, data: { tree: { role: 'window', name: 'Mail', children: [{ role: 'button', name: 'Send', ref_id: '@s:e1' }] } } }
    : { ok: true, data: {} };
};

test('initialize, list tools, and ask through elicitation before a sensitive click', async () => {
  const sent: any[] = [];
  const s = new McpServer((m) => sent.push(m), engine());
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } });
  assert.equal(sent[0].result.protocolVersion, '2025-06-18');
  assert.equal(sent[0].result.serverInfo.name, 'ands');
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(sent[1].result.tools.map((t: any) => t.name), ['ands_look', 'ands_act', 'ands_press', 'ands_mouse', 'ands_type', 'ands_wait', 'ands_apps', 'ands_clipboard', 'ands_screenshot', 'ands_steps',
    'ands_phones', 'ands_phone_look', 'ands_phone_tap', 'ands_phone_type', 'ands_phone_swipe', 'ands_phone_button', 'ands_phone_apps', 'ands_phone_screenshot']);
  assert.ok(sent[1].result.tools.filter((t: any) => !t.name.startsWith('ands_phone')).every((t: any) => t.inputSchema.properties.agent));
  await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ands_look', arguments: { app: 'Mail' } } });
  assert.equal(sent[2].result.isError, false);

  const click = s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ands_act', arguments: { action: 'click', ref: '@s:e1', why: 'send' } } });
  await new Promise((r) => setImmediate(r));
  const ask = sent[3];
  assert.equal(ask.method, 'elicitation/create');
  assert.match(ask.params.message, /Send/);
  assert.deepEqual(ask.params.requestedSchema.properties.answer.enum, ['yes', 'no']); // sensitive: no "yes to all"
  await s.handle({ jsonrpc: '2.0', id: ask.id, result: { action: 'decline' } });
  await click;
  assert.equal(sent[4].result.isError, true);
  assert.match(sent[4].result.content[0].text, /said no/);
});

test('each named agent gets its own cursor in one shared session, and works in the background', async () => {
  const seen: string[][] = [];
  const sent: any[] = [];
  const s = new McpServer((m) => sent.push(m), engine(seen));
  const call = (id: number, args: object) => s.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ands_apps', arguments: { action: 'list', ...args } } });
  await Promise.all([call(1, { agent: 'mail' }), call(2, { agent: 'files' }), call(3, {})]);
  const lines = seen.map((a) => a.join(' '));
  assert.equal(lines.filter((l) => l.startsWith('session start')).length, 1);
  assert.ok(lines.includes('--session run-1 cursor-overlay enable --multi-agent --accent #E8643A'));
  assert.ok(lines.includes('--session run-1 --agent-id mail cursor-overlay enable --accent #E8643A --label mail'));
  assert.ok(lines.includes('--session run-1 --agent-id mail list-apps'));
  assert.ok(lines.includes('--session run-1 --agent-id files list-apps'));
  assert.ok(lines.includes('--session run-1 --agent-id main list-apps'));
  assert.ok(!lines.some((l) => l.includes('--headed')));
  // A named agent's keys must name their app: unscoped keys would land in the person's own window.
  await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ands_press', arguments: { combo: 'tab', why: 'x', agent: 'mail' } } });
  assert.equal(sent.at(-1).result.isError, true);
  assert.match(sent.at(-1).result.content[0].text, /which app/);
  await s.agents.end();
  assert.ok(seen.some((a) => a.join(' ') === 'session end run-1'));
});

test('unknown methods get a JSON-RPC error, notifications get nothing', async () => {
  const sent: any[] = [];
  const s = new McpServer((m) => sent.push(m), engine());
  await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await s.handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32601);
});

test('client configs', () => {
  assert.equal(clientConfig('claude-code'), 'claude mcp add ands -- npx -y andsh mcp');
  assert.deepEqual(JSON.parse(clientConfig('cursor')).mcpServers.ands.args, ['-y', 'andsh', 'mcp']);
});

test('the real binary speaks MCP over stdio', async () => {
  const bin = fileURLToPath(new URL('../bin/ands.mjs', import.meta.url));
  const p = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const line = new Promise<string>((r) => p.stdout.once('data', (d) => r(String(d))));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } }) + '\n');
  const res = JSON.parse((await line).trim());
  p.kill();
  assert.equal(res.result.protocolVersion, '2025-03-26');
});

test('phone tools reach the phone through the same gate', async () => {
  const sent: any[] = [];
  const { Phones } = await import('@ands/core');
  const adb = async (args: string[]) => args.join(' ') === 'devices -l' ? { ok: true, out: 'P1 device model:Pixel\n' } : { ok: true, out: '' };
  const s = new McpServer((m) => sent.push(m), engine(), new Phones({ adb }));
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ands_phones', arguments: {} } });
  assert.match(sent[1].result.content[0].text, /Android "Pixel" id P1: ready/);
  // A tap on a spot ands has never seen is sensitive: with no elicitation, the OS dialog would ask. Autopilot is off, so it is not silently allowed.
  s.gate.approver = async () => 'no';
  await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ands_phone_tap', arguments: { x: 10, y: 10, why: 'x' } } });
  assert.equal(sent[2].result.isError, true);
  assert.match(sent[2].result.content[0].text, /said no/);
});

test('a click in a named app answers with the new screen, and ands_steps runs a sequence in one call', async () => {
  const seen: string[][] = [];
  const run = async (args: string[]) => {
    seen.push(args);
    const cmd = args.find((a) => ['session', 'snapshot', 'batch', 'cursor-overlay'].includes(a));
    if (cmd === 'session') return { ok: true, data: { session_id: 'run-1' } };
    const tree = { role: 'window', name: 'Notes', children: [{ role: 'textfield', name: 'Title', ref_id: '@s:e1' }, { role: 'button', name: 'Done', ref_id: '@s:e2' }] };
    if (cmd === 'snapshot') return { ok: true, data: { tree } };
    if (cmd === 'batch') return { ok: true, data: { results: [{ ok: true, data: {} }, { ok: true, data: {} }, { ok: true, data: { tree: { role: 'window', name: 'Notes saved' } } }] } };
    return { ok: true, data: {} };
  };
  const sent: any[] = [];
  const s = new McpServer((m) => sent.push(m), run);
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  s.gate.trust = 'autopilot';
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ands_look', arguments: { app: 'Notes' } } });
  await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ands_act', arguments: { action: 'click', ref: 'e2', why: 'close' } } });
  assert.match(sent.at(-1).result.content[0].text, /The screen now \(fresh refs\):[\s\S]*Notes saved/);
  await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ands_steps', arguments: { app: 'Notes', steps: [
    { tool: 'ands_act', input: { action: 'type', ref: 'e1', value: 'Groceries', why: 'title' } },
    { tool: 'ands_press', input: { combo: 'return', why: 'save' } },
  ] } } });
  const text = sent.at(-1).result.content[0].text;
  assert.equal(sent.at(-1).result.isError, false);
  assert.match(text, /step 1:/);
  assert.match(text, /Notes saved/);
  const batch = JSON.parse(seen.findLast((a) => a.includes('batch'))!.at(seen.findLast((a) => a.includes('batch'))!.indexOf('batch') + 1)!);
  assert.deepEqual(batch[0], { command: 'press', args: { combo: 'return', app: 'Notes' } });
  await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ands_steps', arguments: { steps: [{ tool: 'ands_look', input: {} }] } } });
  assert.equal(sent.at(-1).result.isError, true);
});
