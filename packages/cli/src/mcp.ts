// ands as an MCP server over stdio (JSON-RPC 2.0, one message per line), written by hand so the
// package has no runtime dependencies. Approvals go to the person through MCP elicitation when the
// client supports it, and through the OS dialog box otherwise.
import { createInterface } from 'node:readline';
import { Agents, AGENT_PARAM, agentId, Gate, TOOLS, PHONE_TOOLS, Phones, isPhoneTool, runTool, runPhoneTool, runEngine, nodePhones, log, loadConfig, type Ask, type Answer, type Runner, type ToolSpec, type ToolResult } from '@ands/core';
import { dialogApprover, question } from './ask.ts';
import { VERSION } from './version.ts';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Send = (msg: object) => void;

/** The tools as outside agents see them: each computer tool takes an optional `agent`, so several jobs can run at once.
 *  Then the phone's tools: the person's own phone, through the same gate. */
const COMPUTER_TOOLS: ToolSpec[] = TOOLS.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, agent: AGENT_PARAM } } }));
/** Several steps in one call: they run in order through the same gate, the first that fails stops the rest,
 *  and the answer ends with the screen after the last one. Half the round trips for a known sequence. */
export const STEPS_TOOL: ToolSpec = {
  name: 'ands_steps',
  description: 'Run several steps on the same screen in one call, in order (type into a field, then press return; fill several fields, then click Save). Each step is { tool, input } with tool one of ands_act, ands_press, ands_type, ands_mouse, ands_wait, and input as that tool takes it. A step that fails stops the rest. The answer ends with the screen after the last step, with fresh refs. Do not put a step that needs to see the result of the one before it in the same call.',
  inputSchema: { type: 'object', properties: {
    app: { type: 'string', description: 'The app the steps work in, as ands_apps lists it; its screen comes back at the end' },
    steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { tool: { type: 'string', enum: ['ands_act', 'ands_press', 'ands_type', 'ands_mouse', 'ands_wait'] }, input: { type: 'object' } }, required: ['tool', 'input'] } },
    agent: AGENT_PARAM,
  }, required: ['steps'] },
};
export const MCP_TOOLS: ToolSpec[] = [...COMPUTER_TOOLS, STEPS_TOOL, ...PHONE_TOOLS];

export class McpServer {
  /** One engine session for this server, with a cursor per agent. */
  agents: Agents;
  phones: Phones;
  gate: Gate;
  send: Send;
  canElicit = false;
  nextId = 1;
  pending = new Map<number, (v: any) => void>();
  lang: 'he' | 'en';
  /** The app each agent last named, for the screen that comes back after a click or a key. */
  apps = new Map<string, string>();

  constructor(send: Send, run: Runner = runEngine, phones: Phones = nodePhones()) {
    const cfg = loadConfig();
    this.phones = phones;
    this.lang = cfg.lang;
    this.send = send;
    this.agents = new Agents(run, { style: ['--accent', '#E8643A'] });
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

  /** ands_steps: each step through runTool (so through the gate); the last one brings the screen back. */
  async steps(args: any, ctx: Parameters<typeof runTool>[2], app: string | undefined): Promise<ToolResult> {
    const steps: { tool: string; input: any }[] = Array.isArray(args.steps) ? args.steps.slice(0, 20) : [];
    const allowed = new Set(STEPS_TOOL.inputSchema.properties.steps.items.properties.tool.enum);
    const lines: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const { tool, input } = steps[i] ?? {};
      if (!allowed.has(tool)) return { ok: false, text: [...lines, `step ${i + 1}: ${tool} cannot run inside ands_steps`].join('\n') };
      const stepApp = (typeof input?.app === 'string' && input.app) || app;
      const last = i === steps.length - 1;
      const r = await runTool(tool, { ...(stepApp && tool !== 'ands_wait' ? { app: stepApp } : {}), ...(input ?? {}) }, { ...ctx, after: last && stepApp ? { app: stepApp } : undefined });
      if (!r.ok) return { ok: false, text: [...lines, `step ${i + 1} (${tool}) failed, the rest did not run: ${r.text}`].join('\n') };
      if (last && !r.screen && stepApp) {
        const look = await runTool('ands_look', { app: stepApp }, ctx);
        return { ok: true, text: [...lines, `step ${i + 1}: ${r.text}`, `The screen now (fresh refs):\n${look.text}`].join('\n') };
      }
      lines.push(`step ${i + 1}: ${r.text}`);
    }
    return { ok: true, text: lines.join('\n') };
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
          instructions: 'ands gives you hands on this computer. Use ands_apps to find an app, ands_look to see it, ands_act/ands_press to act: a click or a key press in a named app answers with the screen after it, so you need no second look. For a known sequence on one screen, ands_steps runs several steps in one call. Steps that send, pay, delete or install wait for the person. Work runs in the background, so the person can keep using the computer. For several independent jobs, run them at once (for example one subagent each) and pass each job its own `agent` name: each gets its own cursor. Keep steps that depend on each other in one job. The person\'s own phone is reachable too (ands_phones, then ands_phone_look / ands_phone_tap / ands_phone_type), for apps that exist only there; it goes through the same approvals.' });
      }
      case 'notifications/initialized': case 'notifications/cancelled': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: MCP_TOOLS });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params ?? {};
        if (!MCP_TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool ${name}`);
        this.gate.task ??= 'mcp session';
        if (isPhoneTool(name)) {
          const r = await runPhoneTool(name, args, { phones: this.phones, gate: this.gate, source: 'mcp:phone', log });
          const content: any[] = [{ type: 'text', text: r.text }];
          if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
          return reply({ content, isError: !r.ok });
        }
        const agent = typeof args.agent === 'string' ? args.agent : undefined;
        const engine = await this.agents.engine(agent);
        const ctx = { engine, gate: this.gate, source: agent ? `mcp:${agentId(agent)}` : 'mcp', log };
        // The app this agent works in: a click or a key there answers with the new screen (no second call to look).
        const key = agent ?? '';
        if (typeof args.app === 'string' && args.app) this.apps.set(key, args.app);
        const app = (typeof args.app === 'string' && args.app) || this.apps.get(key);
        const r = name === STEPS_TOOL.name ? await this.steps(args, ctx, app) : await runTool(name, args, { ...ctx, after: app ? { app } : undefined });
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
  // The agent is gone: take its cursors off the screen.
  rl.on('close', () => { server.agents.end(); });
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
