// ands as an MCP server over stdio (JSON-RPC 2.0, one message per line), written by hand so the
// package has no runtime dependencies. Approvals go to the person through MCP elicitation when the
// client supports it, and through the OS dialog box otherwise.
import { createInterface } from 'node:readline';
import { Engine, Gate, TOOLS, runTool, runEngine, log, loadConfig, type Ask, type Answer } from '@ands/core';
import { dialogApprover, question } from './ask.ts';
import { VERSION } from './version.ts';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Send = (msg: object) => void;

export class McpServer {
  engine: Engine;
  gate: Gate;
  send: Send;
  canElicit = false;
  nextId = 1;
  pending = new Map<number, (v: any) => void>();
  lang: 'he' | 'en';

  constructor(send: Send, engine = new Engine(runEngine)) {
    const cfg = loadConfig();
    this.lang = cfg.lang;
    this.send = send;
    this.engine = engine;
    const dialog = dialogApprover(this.lang);
    this.gate = new Gate({ trust: cfg.trust, blocked: cfg.blocked, approver: (ask) => (this.canElicit ? this.elicit(ask) : dialog(ask)) });
  }

  request(method: string, params: object): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((res) => this.pending.set(id, res));
  }

  async elicit(ask: Ask): Promise<Answer> {
    const options = ask.tier === 'sensitive' ? ['yes', 'no'] : ['yes', 'yes_for_task', 'no'];
    const r = await this.request('elicitation/create', {
      message: `ands wants to: ${question(ask, this.lang)}`,
      requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Allow?', enum: options, enumNames: options.map((o) => ({ yes: 'Yes', yes_for_task: 'Yes to every change in this task', no: 'No' })[o]) } }, required: ['answer'] },
    }).catch(() => null);
    if (r?.action !== 'accept') return 'no';
    const a = r.content?.answer;
    return a === 'yes' || (a === 'yes_for_task' && ask.tier !== 'sensitive') ? a : 'no';
  }

  async handle(msg: any): Promise<void> {
    if (msg.id !== undefined && !msg.method) { // a response to our request
      this.pending.get(msg.id)?.(msg.error ? Promise.reject(msg.error) : msg.result);
      this.pending.delete(msg.id);
      return;
    }
    const reply = (result: object) => this.send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => this.send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const v = msg.params?.protocolVersion;
        this.canElicit = !!msg.params?.capabilities?.elicitation;
        return reply({ protocolVersion: SUPPORTED.includes(v) ? v : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: { name: 'ands', version: VERSION },
          instructions: 'ands gives you hands on this computer. Use ands_apps to find an app, ands_look to see it, ands_act/ands_press to act, and ands_look again to check. Steps that send, pay, delete or install wait for the person.' });
      }
      case 'notifications/initialized': case 'notifications/cancelled': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params ?? {};
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool ${name}`);
        this.gate.task ??= 'mcp session';
        const r = await runTool(name, args, { engine: this.engine, gate: this.gate, source: 'mcp', log });
        const content: any[] = [{ type: 'text', text: r.text }];
        if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
        return reply({ content, isError: !r.ok });
      }
      default:
        if (msg.id !== undefined) return fail(-32601, `Method not found: ${msg.method}`);
    }
  }
}

export function serveStdio() {
  const server = new McpServer((m) => process.stdout.write(JSON.stringify(m) + '\n'));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return server.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    server.handle(msg).catch((e) => msg.id !== undefined && server.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }));
  });
}

/** Ready-to-paste config for MCP clients. */
export function clientConfig(client: string): string {
  const entry = { command: 'npx', args: ['-y', 'andsh', 'mcp'] };
  if (client === 'claude-code') return 'claude mcp add ands -- npx -y andsh mcp';
  if (client === 'codex') return '[mcp_servers.ands]\ncommand = "npx"\nargs = ["-y", "andsh", "mcp"]';
  if (client === 'vscode') return JSON.stringify({ servers: { ands: { type: 'stdio', ...entry } } }, null, 2);
  return JSON.stringify({ mcpServers: { ands: entry } }, null, 2); // cursor, claude-desktop, windsurf
}
