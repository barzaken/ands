// The engine is the agent-desktop binary (vercel-labs/agent-desktop, Apache-2.0, unmodified release). Every command prints one JSON
// envelope: { ok, command, data } or { ok:false, error:{ code, message, disposition, suggestion } }.
// This file runs anywhere (Node and the desktop app's window); how a command reaches the binary is the
// Runner's job: engine-node.ts spawns it, the desktop app asks its Rust side.

export type Envelope = {
  ok: boolean;
  command?: string;
  data?: any;
  error?: { code: string; message: string; suggestion?: string; details?: unknown; disposition?: { retry?: string; delivered?: string } };
};

export type RefInfo = { role: string; name: string };

export type Runner = (args: string[], timeoutMs?: number) => Promise<Envelope>;

/** Collects every ref in a snapshot tree with its role and name, so the gate can tell what an action touches. */
export function collectRefs(tree: any, into = new Map<string, RefInfo>()): Map<string, RefInfo> {
  if (!tree || typeof tree !== 'object') return into;
  if (typeof tree.ref_id === 'string') into.set(tree.ref_id, { role: String(tree.role ?? ''), name: String(tree.name ?? '') });
  for (const c of tree.children ?? []) collectRefs(c, into);
  return into;
}

const PHYSICAL = new Set(['click', 'double-click', 'right-click', 'type', 'clear', 'scroll']);

/** A thin, typed face over the engine that remembers the refs it has seen. */
export class Engine {
  refs = new Map<string, RefInfo>();
  run: Runner;
  /** `globals` go before every command, e.g. ['--headed', '--session', id] in the desktop app, where the person
   *  watches the real pointer move and keys reach fields that only take physical input. */
  /** Moves the real pointer onto the element before each action, so the person sees what is being selected or changed. */
  pointTo: boolean;
  constructor(run: Runner, globals: string[] = [], o: { pointTo?: boolean } = {}) {
    this.run = globals.length ? (args, timeoutMs) => run([...globals, ...args], timeoutMs) : run;
    this.pointTo = o.pointTo ?? false;
  }

  /** The field ands last typed into, so Return there can be told apart (search vs. message). */
  lastTyped?: RefInfo;

  async snapshot(o: { app?: string; windowId?: string; root?: string; interactive?: boolean; compact?: boolean; skeleton?: boolean; timeoutMs?: number } = {}) {
    const a = ['snapshot'];
    // Browsers and other Chromium apps need longer than the engine's 3 s default to show a page, but a
    // big page uses the whole deadline on every look, so it stays short: a cut tree says so, and a
    // look with text (find) gets one element without reading the page.
    a.push('--timeout-ms', String(o.timeoutMs ?? 5000));
    if (o.app) a.push('--app', o.app);
    if (o.windowId) a.push('--window-id', o.windowId);
    if (o.root) a.push('--root', o.root);
    if (o.interactive !== false) a.push('-i');
    if (o.compact !== false) a.push('--compact');
    if (o.skeleton) a.push('--skeleton');
    const e = await this.run(a);
    if (e.ok) collectRefs(e.data?.tree, this.refs);
    return e;
  }
  /** Elements whose name or text contains `text` (and of `role`, when given), with refs to act on. */
  async find(o: { app?: string; windowId?: string; text: string; role?: string }) {
    const a = ['find', '--text', o.text, '--limit', '20'];
    if (o.app) a.push('--app', o.app);
    if (o.windowId) a.push('--window-id', o.windowId);
    if (o.role) a.push('--role', o.role);
    const e = await this.run(a);
    if (e.ok) for (const m of e.data?.matches ?? []) if (typeof m.ref_id === 'string') this.refs.set(m.ref_id, { role: String(m.role ?? ''), name: String(m.name ?? '') });
    return e;
  }
  /** One action on a ref; `verb` is an engine command name (click, type, select, toggle, scroll ...). */
  async act(verb: string, ref: string, value?: string, extra: string[] = []) {
    // Only reached from inside an action the gate already allowed; a failed hover never stops the action.
    // Clicks, typing and scrolling move the pointer themselves when headed; other actions get a hover first.
    if (this.pointTo && !PHYSICAL.has(verb)) await this.run(['hover', ref]).catch(() => undefined);
    const a = [verb, ref];
    if (value !== undefined) a.push(value);
    return this.run([...a, ...extra]);
  }
  press(combo: string, app?: string) { return this.run(app ? ['press', combo, '--app', app] : ['press', combo]); }
  listApps() { return this.run(['list-apps']); }
  listWindows(app?: string) { return this.run(app ? ['list-windows', '--app', app] : ['list-windows']); }
  launch(app: string) { return this.run(['launch', app, '--activate']); }
  closeApp(app: string) { return this.run(['close-app', app]); }
  clipboardGet() { return this.run(['clipboard-get']); }
  clipboardSet(text: string) { return this.run(['clipboard-set', text]); }
  screenshot(app?: string) { return this.run(app ? ['screenshot', '--app', app] : ['screenshot']); }
  permissions() { return this.run(['permissions']); }
}
