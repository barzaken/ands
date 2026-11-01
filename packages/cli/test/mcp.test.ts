import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '@ands/core';
import { McpServer, clientConfig } from '../src/mcp.ts';

process.env.ANDS_HOME = `${process.env.TMPDIR ?? '/tmp'}/ands-mcp-test-${process.pid}`;

const engine = () => new Engine(async (args) => args[0] === 'snapshot'
  ? { ok: true, data: { tree: { role: 'window', name: 'Mail', children: [{ role: 'button', name: 'Send', ref_id: '@s:e1' }] } } }
  : { ok: true, data: {} });

test('initialize, list tools, and ask through elicitation before a sensitive click', async () => {
  const sent: any[] = [];
  const s = new McpServer((m) => sent.push(m), engine());
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } });
  assert.equal(sent[0].result.protocolVersion, '2025-06-18');
  assert.equal(sent[0].result.serverInfo.name, 'ands');
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(sent[1].result.tools.map((t: any) => t.name), ['ands_look', 'ands_act', 'ands_press', 'ands_apps', 'ands_clipboard', 'ands_screenshot']);
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
