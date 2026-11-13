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
/** An element's rectangle on the screen, in the points the pointer uses. */
export type Box = { x: number; y: number; width: number; height: number };
const toBox = (b: any): Box | undefined => {
  if (!b || typeof b !== 'object') return undefined;
  const [x, y, width, height] = [b.x, b.y, b.width ?? b.w, b.height ?? b.h].map(Number);
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : undefined;
};
function collectBoxes(tree: any, into: Map<string, Box>) {
  if (!tree || typeof tree !== 'object') return;
  const b = toBox(tree.bounds);
  if (typeof tree.ref_id === 'string' && b) into.set(tree.ref_id, b);
  for (const c of tree.children ?? []) collectBoxes(c, into);
}

export type Runner = (args: string[], timeoutMs?: number) => Promise<Envelope>;
/** The screen to read right after a step: which app or window, how long to let it draw first. */
export type Look = { app?: string; windowId?: string; waitMs?: number; timeoutMs?: number };

/** Collects every ref in a snapshot tree with its role and name, so the gate can tell what an action touches. */
export function collectRefs(tree: any, into = new Map<string, RefInfo>()): Map<string, RefInfo> {
  if (!tree || typeof tree !== 'object') return into;
  if (typeof tree.ref_id === 'string') into.set(tree.ref_id, { role: String(tree.role ?? ''), name: String(tree.name ?? '') });
  for (const c of tree.children ?? []) collectRefs(c, into);
  return into;
}

const PHYSICAL = new Set(['click', 'double-click', 'triple-click', 'right-click', 'hover', 'type', 'clear', 'scroll']);

/** Runs one thing at a time, in the order asked. */
export type Lock = <T>(f: () => Promise<T>) => Promise<T>;
export function serial(): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(f: () => Promise<T>) => {
    const r = tail.then(f, f);
    tail = r.catch(() => undefined);
    return r;
  };
}

/** The engine refused a step headless because it needs real keys or the pointer, and nothing was delivered. */
const needsHands = (e: Envelope) => !e.ok && e.error?.code === 'POLICY_DENIED' && e.error?.disposition?.retry === 'safe';
/** The element is there but the accessibility path cannot reach it: covered by something, zero-sized, clipped. */
const notReachable = (e: Envelope) => !e.ok && /ACTION_FAILED|TIMEOUT|ACTION_NOT_SUPPORTED/.test(e.error?.code ?? '') && /actionable|occluded|bounds|clipped|not supported|press action/i.test(`${e.error?.message} ${JSON.stringify(e.error?.details ?? '')}`);
/** Pointer gestures a ref action can fall back to, as a person would do them. */
const BY_POINTER: Record<string, { button: string; count: number }> = {
  click: { button: 'left', count: 1 }, 'double-click': { button: 'left', count: 2 }, 'triple-click': { button: 'left', count: 3 }, 'right-click': { button: 'right', count: 1 },
};
export type PointerAction = 'click' | 'double-click' | 'triple-click' | 'right-click' | 'middle-click' | 'move' | 'drag' | 'scroll';
const MODIFIERS = new Set(['shift', 'cmd', 'meta', 'ctrl', 'alt']);

const isMac = () => {
  const g = globalThis as any;
  return g.process?.platform ? g.process.platform === 'darwin' : /Mac/i.test(String(g.navigator?.platform ?? g.navigator?.userAgent ?? ''));
};

/** A thin, typed face over the engine that remembers the refs it has seen. */
export class Engine {
  refs = new Map<string, RefInfo>();
  run: Runner;
  /** `globals` go before every command, e.g. ['--headed', '--session', id] in the desktop app, where the person
   *  watches the real pointer move and keys reach fields that only take physical input. */
  /** Moves the real pointer onto the element before each action, so the person sees what is being selected or changed. */
  pointTo: boolean;
  /** In the background (several agents at once, or the person still working), steps run headless: through
   *  accessibility, without the real pointer or keyboard. A step that has no headless path (a key press, typing
   *  on Windows, a double-click) runs again with real input, holding `hands` so only one agent at a time uses
   *  the real keyboard and pointer. */
  hands?: Lock;
  /** One of several agents: a key press must name its app, since unscoped keys reach whatever is in front. */
  background: boolean;
  /** Every command already runs with real input (`--headed` in the globals); the engine takes the flag once. */
  headed: boolean;
  /** Where elements were on the last screen looked at with bounds, to tell what a click at a point lands on. */
  boxes = new Map<string, Box>();
  constructor(run: Runner, globals: string[] = [], o: { pointTo?: boolean; hands?: Lock; background?: boolean } = {}) {
    this.headed = globals.includes('--headed');
    this.run = globals.length ? (args, timeoutMs) => run([...globals, ...args], timeoutMs) : run;
    this.pointTo = o.pointTo ?? false;
    this.hands = o.hands;
    this.background = o.background ?? false;
  }

  /** Runs a step; in the background, one that needs real input runs again holding the hands. */
  async physical(args: string[]): Promise<Envelope> {
    const e = await this.run(args);
    const hands = this.hands;
    return hands && needsHands(e) ? hands(() => this.run(['--headed', ...args])) : e;
  }

  /** Runs a step with the real pointer and keyboard, one agent at a time. */
  withHands(args: string[]): Promise<Envelope> {
    const a = this.headed ? args : ['--headed', ...args];
    return this.hands ? this.hands(() => this.run(a)) : this.run(a);
  }

  /** The smallest element of the last screen (looked at with bounds) under a point, if any. */
  at(x: number, y: number): { ref: string; info: RefInfo } | undefined {
    let best: { ref: string; area: number } | undefined;
    for (const [ref, b] of this.boxes) {
      if (b.width <= 0 || b.height <= 0 || x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) continue;
      const area = b.width * b.height;
      if (!best || area < best.area) best = { ref, area };
    }
    const info = best && this.refs.get(best.ref);
    return best && info ? { ref: best.ref, info } : undefined;
  }

  /** Short refs as the model sees them (e5) to the engine's qualified refs (@s8f3k2p9:e5), latest screen first. */
  short = new Map<string, string>();
  /** A ref as the model wrote it ("e5", "@e5" or the full "@s…:e5") as the engine takes it. */
  full(ref: unknown): string {
    const r = String(ref ?? '').trim();
    const m = /^@?(e\d+)$/.exec(r);
    return m ? this.short.get(m[1]) ?? r : r;
  }
  private remember(ref: string, info: RefInfo) {
    this.refs.set(ref, info);
    this.short.set(ref.slice(ref.lastIndexOf(':') + 1), ref);
  }

  /** The field ands last typed into, so Return there can be told apart (search vs. message). */
  lastTyped?: RefInfo;

  async snapshot(o: { app?: string; windowId?: string; root?: string; interactive?: boolean; compact?: boolean; skeleton?: boolean; bounds?: boolean; timeoutMs?: number } = {}) {
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
    if (o.bounds) a.push('--include-bounds');
    return this.took(await this.run(a), !!o.root);
  }
  /** Remembers the refs and places of a screen just read. */
  private took(e: Envelope, part = false): Envelope {
    if (e.ok) {
      // A new screen: short refs now mean its elements (a full look, not a drill into one part).
      if (!part) { this.short.clear(); this.boxes.clear(); }
      collectBoxes(e.data?.tree, this.boxes);
      for (const [ref, info] of collectRefs(e.data?.tree)) this.remember(ref, info);
    }
    return e;
  }

  /**
   * One step, a short pause and the new screen, in one start of the engine (its `batch`) instead of three.
   * Only for a step the engine takes as is (a click or a key); anything else, or an engine that refuses the
   * batch, goes the usual way through `fallback`, and then no screen comes back. The caller has already
   * passed both the step and the look through the gate.
   */
  async thenLook(first: { command: string; args: Record<string, unknown> }, fallback: () => Promise<Envelope>, look: Look = {}): Promise<{ act: Envelope; screen?: Envelope }> {
    const snap: Record<string, unknown> = { interactive_only: true, compact: true, timeout_ms: look.timeoutMs ?? 5000 };
    if (look.app) snap.app = look.app;
    if (look.windowId) snap.window_id = look.windowId;
    const entries = [first, { command: 'wait', args: { ms: Math.max(0, Math.round(look.waitMs ?? 80)) } }, { command: 'snapshot', args: snap }];
    const b = await this.run(['batch', JSON.stringify(entries), '--stop-on-error', '--timeout-ms', '20000']).catch(() => undefined);
    const results: Envelope[] | undefined = b?.ok && Array.isArray(b.data?.results) ? b.data.results : undefined;
    const act = results?.[0];
    // No batch (an older engine, a refused entry), or the step needs the real hands or the pointer: the usual way.
    if (!act || !act.ok) {
      if (act && !needsHands(act) && !notReachable(act)) return { act };
      return { act: await fallback() };
    }
    const screen = results[2];
    return { act, screen: screen ? this.took(screen) : undefined };
  }
  /** Elements whose name or text contains `text` (and of `role`, when given), with refs to act on. */
  async find(o: { app?: string; windowId?: string; text: string; role?: string }) {
    const a = ['find', '--text', o.text, '--limit', '20'];
    if (o.app) a.push('--app', o.app);
    if (o.windowId) a.push('--window-id', o.windowId);
    if (o.role) a.push('--role', o.role);
    const e = await this.run(a);
    if (e.ok) for (const m of e.data?.matches ?? []) if (typeof m.ref_id === 'string') {
      this.remember(m.ref_id, { role: String(m.role ?? ''), name: String(m.name ?? '') });
      const b = toBox(m.bounds);
      if (b) this.boxes.set(m.ref_id, b);
    }
    return e;
  }
  /** Where an element is now, or undefined when the engine cannot say or it has no size. */
  async bounds(ref: string): Promise<Box | undefined> {
    const e = await this.run(['get', ref, '--property', 'bounds']).catch(() => undefined);
    const d = e?.ok ? e.data : undefined;
    const b = toBox(d?.value ?? d?.bounds ?? d);
    return b && b.width > 0 && b.height > 0 ? b : undefined;
  }
  /** One action on a ref; `verb` is an engine command name (click, type, select, toggle, scroll ...). */
  async act(verb: string, ref: string, value?: string, extra: string[] = []) {
    // Only reached from inside an action the gate already allowed; a failed hover never stops the action.
    // Clicks, typing and scrolling move the pointer themselves when headed; other actions get a hover first.
    if (this.pointTo && !PHYSICAL.has(verb)) await this.run(['hover', ref]).catch(() => undefined);
    const a = [verb, ref];
    if (value !== undefined) a.push(value);
    const e = await this.physical([...a, ...extra]);
    // Covered by a banner or picture, or drawn without a size the accessibility path can use: do what a
    // person does, and click where the element is with the real pointer. Same element, same approval.
    const by = BY_POINTER[verb];
    if (by && notReachable(e)) {
      const b = this.boxes.get(ref) ?? (await this.bounds(ref));
      if (b && b.width > 0 && b.height > 0) {
        const p = await this.pointer('click', { x: b.x + b.width / 2, y: b.y + b.height / 2, button: by.button, count: by.count });
        if (p.ok) return { ...p, data: { ...(p.data ?? {}), note: 'Done with the real pointer, since the element could not be reached directly.' } };
      }
    }
    return e;
  }
  /** The real pointer, like a person's hand: click (any button, 1-3 times), move, drag, or scroll the wheel at a point. */
  pointer(action: PointerAction, o: { x?: number; y?: number; ref?: string; toX?: number; toY?: number; to?: string; button?: string; count?: number; modifiers?: string[]; dx?: number; dy?: number }): Promise<Envelope> {
    const xy = (x?: number, y?: number) => `${Math.round(Number(x))},${Math.round(Number(y))}`;
    const has = (x?: number, y?: number) => Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== undefined && y !== undefined;
    const mods = (o.modifiers ?? []).map((m) => String(m).toLowerCase()).filter((m) => MODIFIERS.has(m)).flatMap((m) => ['--modifiers', m === 'cmd' ? 'meta' : m]);
    const bad = (message: string): Promise<Envelope> => Promise.resolve({ ok: false, error: { code: 'INVALID_ARGS', message, disposition: { retry: 'safe' } } });
    if (action === 'move') {
      if (o.ref) return this.withHands(['hover', o.ref]);
      return has(o.x, o.y) ? this.withHands(['mouse-move', '--xy', xy(o.x, o.y)]) : bad('Say where: x and y, or a ref.');
    }
    if (action === 'drag') {
      const from = o.ref ? ['--from', o.ref] : has(o.x, o.y) ? ['--from-xy', xy(o.x, o.y)] : undefined;
      const to = o.to ? ['--to', o.to] : has(o.toX, o.toY) ? ['--to-xy', xy(o.toX, o.toY)] : undefined;
      return from && to ? this.withHands(['drag', ...from, ...to]) : bad('A drag needs where it starts (ref, or x and y) and where it ends (to, or to_x and to_y).');
    }
    if (action === 'scroll') {
      if (!has(o.x, o.y)) return bad('Say where to scroll: x and y.');
      return this.withHands(['mouse-wheel', `--x=${Math.round(Number(o.x))}`, `--y=${Math.round(Number(o.y))}`, `--dy=${Math.round(o.dy ?? (o.dx ? 0 : -3))}`, `--dx=${Math.round(o.dx ?? 0)}`, ...mods]);
    }
    if (!has(o.x, o.y)) return bad('Say where to click: x and y.');
    const g = action === 'click' ? undefined : BY_POINTER[action];
    const button = action === 'middle-click' ? 'middle' : g?.button ?? o.button ?? 'left';
    const count = g?.count ?? Math.min(3, Math.max(1, Math.round(o.count ?? 1)));
    return this.withHands(['mouse-click', '--xy', xy(o.x, o.y), '--button', button, '--count', String(count), ...mods]);
  }
  /** Types into whatever has the keyboard focus, as pasted text (so every language and tabs between cells arrive whole). */
  async typeHere(text: string, app?: string, mac = isMac()): Promise<Envelope> {
    if (this.background && !app) return { ok: false, error: { code: 'INVALID_ARGS', message: 'Working in the background: say which app gets the text (app).', disposition: { retry: 'safe' } } };
    const set = await this.clipboardSet(text);
    if (!set.ok) return set;
    const combo = mac ? 'cmd+v' : 'ctrl+v';
    return this.withHands(app ? ['press', combo, '--app', app] : ['press', combo]);
  }
  /** Waits a moment, or until a text shows up in an app. */
  wait(o: { ms?: number; text?: string; app?: string }): Promise<Envelope> {
    const ms = Math.min(20_000, Math.max(100, Math.round(o.ms ?? (o.text ? 10_000 : 1000))));
    if (o.text) return this.run(['wait', '--text', o.text, '--timeout', String(ms), ...(o.app ? ['--app', o.app] : [])]);
    return this.run(['wait', String(ms)]);
  }
  press(combo: string, app?: string): Promise<Envelope> {
    // Unscoped keys go to whatever app is in front, which in the background is the person's own.
    if (this.background && !app) return Promise.resolve({ ok: false, error: { code: 'INVALID_ARGS', message: 'Working in the background: say which app gets the key (app).', disposition: { retry: 'safe' } } });
    return this.physical(app ? ['press', combo, '--app', app] : ['press', combo]);
  }
  listApps() { return this.run(['list-apps']); }
  listWindows(app?: string) { return this.run(app ? ['list-windows', '--app', app] : ['list-windows']); }
  launch(app: string) { return this.run(['launch', app, '--activate']); }
  closeApp(app: string) { return this.run(['close-app', app]); }
  clipboardGet() { return this.run(['clipboard-get']); }
  clipboardSet(text: string) { return this.run(['clipboard-set', text]); }
  screenshot(app?: string) { return this.run(app ? ['screenshot', '--app', app] : ['screenshot']); }
  permissions() { return this.run(['permissions']); }
}
