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
  assert.deepEqual(sent[1].result.tools.map((t: any) => t.name), ['ands_look', 'ands_act', 'ands_press', 'ands_apps', 'ands_clipboard', 'ands_screenshot']);
  assert.ok(sent[1].result.tools.every((t: any) => t.inputSchema.properties.agent));
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
