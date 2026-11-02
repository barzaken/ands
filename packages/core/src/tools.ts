// The hands, as tools. One definition serves the MCP server (for outside agents) and the agent's own loop.
// Every call goes through the gate before it reaches the engine, and every call is logged.
import type { Engine, Envelope, PointerAction } from './engine.ts';
import { Gate, type Verdict } from './gate.ts';
import type { Action } from './policy.ts';
import { compactScreen, compactMatches, quiet, type ScreenOptions } from './screen.ts';

export type ToolSpec = { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] } };

const why = { type: 'string', description: 'One short sentence, for the person, on why this step is needed.' };

export const TOOLS: ToolSpec[] = [
  { name: 'ands_look', description: 'See an app: returns its window as short lines, one element each (role, "name", ref like e8, = value, [states]), indented under the groups they sit in. Refs belong to that screen; look again after the screen changes. To find one thing (a "Download" button, a file name), pass text: only matching elements come back, which is much faster. To read what a page or document says (search results, an email, an article, a table), pass read:true: every text comes back, long enough to read (with root:<ref> for one part). bounds:true adds where each element is (@x,y widthxheight, in screen points) for ands_mouse. For dense apps pass skeleton:true first, then root:<ref> to drill in.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App name exactly as ands_apps lists it, e.g. "Safari", "Google Chrome", "Finder". Never translate it into the person\'s language.' }, window_id: { type: 'string' }, text: { type: 'string', description: 'Only elements whose name or text contains this, e.g. "Download"' }, role: { type: 'string', description: 'With text: only this kind of element, e.g. "button", "link"' }, root: { type: 'string', description: 'Ref to start from' }, skeleton: { type: 'boolean' }, read: { type: 'boolean', description: 'Every text on the screen, not only what can be clicked: to read results, messages, articles' }, bounds: { type: 'boolean', description: 'Add where each element is on the screen' } } } },
  { name: 'ands_act', description: 'Do one thing to an element from your last ands_look: click, double-click, triple-click, right-click, hover (point at it, e.g. to open a menu), type, set-value, select, toggle, check, uncheck, scroll, scroll-to, focus, clear, expand, collapse. When an element cannot be reached directly (covered, or without a size), a click is done with the real pointer where it is. Look again afterwards to confirm it worked. Steps that send, pay, delete or install wait for the person to approve.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'double-click', 'triple-click', 'right-click', 'hover', 'type', 'set-value', 'select', 'toggle', 'check', 'uncheck', 'scroll', 'scroll-to', 'focus', 'clear', 'expand', 'collapse'] }, ref: { type: 'string' }, value: { type: 'string', description: 'Text for type/set-value, option for select, direction for scroll' }, app: { type: 'string' }, why }, required: ['action', 'ref', 'why'] } },
  { name: 'ands_press', description: 'Press a key or shortcut, e.g. "return", "escape", "cmd+c", "ctrl+shift+t". Return right after typing into a search or address field just searches; elsewhere Return waits for approval because it often sends or submits.',
    inputSchema: { type: 'object', properties: { combo: { type: 'string' }, app: { type: 'string' }, why }, required: ['combo', 'why'] } },
  { name: 'ands_mouse', description: 'The real mouse, like a person\'s hand, for what ands_act cannot do: click, double-click, triple-click, right-click or middle-click at a point; move (hover) there; drag from one place to another (files, sliders, text, cards); scroll the wheel at a point. Points are screen coordinates from ands_look bounds:true (@x,y widthxheight: aim at the middle) or from a screenshot. A ref instead of x and y works too. Hold keys with modifiers, e.g. ["cmd"] or ["shift"]. Prefer ands_act when the element has a ref: it is faster and does not move the person\'s pointer. A click on a point whose element ands has not seen asks the person first.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'double-click', 'triple-click', 'right-click', 'middle-click', 'move', 'drag', 'scroll'] }, x: { type: 'number' }, y: { type: 'number' }, ref: { type: 'string', description: 'An element from the last ands_look, instead of x and y' }, to_x: { type: 'number' }, to_y: { type: 'number' }, to: { type: 'string', description: 'Drag: the element to drop on, instead of to_x and to_y' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default down)' }, amount: { type: 'number', description: 'Scroll: how many lines (default 3)' }, modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'cmd', 'ctrl', 'alt'] } }, app: { type: 'string' }, why }, required: ['action', 'why'] } },
  { name: 'ands_type', description: 'Type text where the keyboard is now (after clicking a field, a cell or a document), like a person typing, in any language. Text with tabs between cells and new lines between rows fills a whole table at once in Google Sheets, Excel or Numbers: click the first cell, then type it all in one step. Uses the clipboard to deliver the text. For a field that has a ref, ands_act type is better.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, app: { type: 'string' }, why }, required: ['text', 'app', 'why'] } },
  { name: 'ands_wait', description: 'Wait for a page or app to finish: a number of milliseconds (ms), or until a text shows up in an app (text, app). Better than looking again and again.',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' }, text: { type: 'string' }, app: { type: 'string' } } } },
  { name: 'ands_apps', description: 'List running apps or their windows, open an app, or quit one.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'windows', 'open', 'quit'] }, app: { type: 'string' }, why }, required: ['action'] } },
  { name: 'ands_clipboard', description: 'Read or set the clipboard. Reading asks the person first, since it may hold private text.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'set'] }, text: { type: 'string' }, why }, required: ['action'] } },
  { name: 'ands_screenshot', description: 'A picture of the screen or one app, for models that can see images. Prefer ands_look: it is faster and gives refs. Asks the person first.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, why } } },
];

const POINTER_ACTIONS: PointerAction[] = ['click', 'double-click', 'triple-click', 'right-click', 'middle-click', 'move', 'drag', 'scroll'];

export type ToolResult = { ok: boolean; text: string; image?: { data: string; mimeType: string } };

const MAX = 40_000;
const shown = (e: Envelope, as?: 'screen' | 'matches', o: ScreenOptions = {}) => {
  const s = e.ok && as === 'screen' ? compactScreen(e.data, o) : e.ok && as === 'matches' ? compactMatches(e.data, o) : JSON.stringify(e.ok ? quiet(e.data) : e.error);
  return s.length > MAX ? s.slice(0, MAX) + '…(cut: look at a smaller root)' : s;
};

/** Runs one tool call: build the action, ask the gate, run the engine, log. */
/** One line of the action log. Typed values are never written: only that something was typed. */
export type LogEntry = { at: string; task?: string; source: string; verb: string; app?: string; target?: string; tier: string; allowed: boolean; ok?: boolean; note?: string };
export type Logger = (e: Omit<LogEntry, 'at'>) => void;

export async function runTool(name: string, input: any, ctx: { engine: Engine; gate: Gate; source: string; log?: Logger }): Promise<ToolResult> {
  const { engine, gate, source } = ctx;
  const log: Logger = ctx.log ?? (() => {});
  const act = async (action: Action, run: () => Promise<Envelope>, as?: 'screen' | 'matches', so?: ScreenOptions): Promise<ToolResult> => {
    const v: Verdict = await gate.check(action);
    const target = action.target ? `${action.target.role}: ${action.target.name}` : action.ref;
    if (!v.allowed) {
      log({ task: gate.task, source, verb: action.verb, app: action.app, target, tier: v.tier, allowed: false, note: v.reason });
      return { ok: false, text: `Not done: ${v.reason} Ask the person what they want instead.` };
    }
    const e = await run();
    log({ task: gate.task, source, verb: action.verb, app: action.app, target, tier: v.tier, allowed: true, ok: e.ok, note: e.ok ? undefined : e.error?.code });
    if (!e.ok) {
      // Details carry what the model needs to recover, e.g. the window ids behind AMBIGUOUS_TARGET.
      const details = e.error?.details === undefined ? '' : ` Details: ${JSON.stringify(e.error.details).slice(0, 2000)}`;
      const hint = e.error?.code === 'APP_NOT_FOUND' ? ' Use the app name exactly as ands_apps lists it (e.g. "Calculator", not a translation). If the app is not installed, do the job another way: another app that does the same (Numbers or Google Sheets for Excel, Pages or Google Docs for Word, Keynote for PowerPoint), its website, or a file.' : '';
      return { ok: false, text: `${e.error?.code}: ${e.error?.message}${e.error?.suggestion ? ` Suggestion: ${e.error.suggestion}` : ''}${details}${hint}` };
    }
    return { ok: true, text: shown(e, as, so) };
  };

  switch (name) {
    case 'ands_look': {
      const so: ScreenOptions = { read: !!input.read, bounds: !!input.bounds };
      if (input.text) return act({ verb: 'find', app: input.app }, () => engine.find({ app: input.app, windowId: input.window_id, text: String(input.text), role: input.role }), 'matches', so);
      // A tree the engine could not finish in time (a big web page) says so in its last line, so the model narrows instead of guessing.
      return act({ verb: 'look', app: input.app }, () => engine.snapshot({ app: input.app, windowId: input.window_id, root: input.root ? engine.full(input.root) : undefined, skeleton: input.skeleton, interactive: !input.read, bounds: so.bounds }), 'screen', so);
    }
    case 'ands_act': {
      const verb = String(input.action);
      const extra = verb === 'scroll' && input.value ? ['--direction', String(input.value)] : [];
      const value = ['type', 'set-value', 'select'].includes(verb) ? String(input.value ?? '') : undefined;
      const ref = engine.full(input.ref);
      const target = engine.refs.get(ref);
      const r = await act({ verb: verb === 'set-value' ? 'set_value' : verb, app: input.app, ref, target, value, why: input.why },
        () => engine.act(verb, ref, value, extra));
      if (r.ok) engine.lastTyped = verb === 'type' || verb === 'set-value' ? target : undefined;
      return r;
    }
    case 'ands_mouse': {
      const action = String(input.action ?? '') as PointerAction;
      if (!POINTER_ACTIONS.includes(action)) return { ok: false, text: `action must be one of ${POINTER_ACTIONS.join(', ')}` };
      const ref = input.ref ? engine.full(input.ref) : undefined;
      const to = input.to ? engine.full(input.to) : undefined;
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
      const [x, y, toX, toY] = [num(input.x), num(input.y), num(input.to_x), num(input.to_y)];
      // What the gesture lands on, from the screen (never from the model): the ref, or the element under the point.
      // A drag is judged by where it drops.
      const end = action === 'drag' ? (to ? { ref: to, info: engine.refs.get(to) } : toX !== undefined && toY !== undefined ? engine.at(toX, toY) : undefined)
        : ref ? { ref, info: engine.refs.get(ref) } : x !== undefined && y !== undefined ? engine.at(x, y) : undefined;
      const where = ref ?? (x !== undefined ? `${Math.round(x)},${Math.round(y ?? 0)}` : '');
      const lines = Math.max(1, Math.min(50, Math.round(num(input.amount) ?? 3)));
      const dir = String(input.direction ?? 'down');
      let point = { x, y };
      if (action === 'scroll' && ref && x === undefined) {
        const b = engine.boxes.get(ref) ?? (await engine.bounds(ref));
        if (b) point = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      // A click at a ref goes to the middle of where that element is now.
      if (ref && action !== 'drag' && action !== 'move' && action !== 'scroll' && x === undefined) {
        const b = engine.boxes.get(ref) ?? (await engine.bounds(ref));
        if (!b) return { ok: false, text: 'That element has no place on the screen to click. Use ands_act, or ands_look with bounds:true and click a point.' };
        point = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      return act({ verb: `mouse_${action}`, app: input.app, ref: end?.ref, target: end?.info, value: where, why: input.why }, () => engine.pointer(action, {
        ...point, ref: action === 'drag' || action === 'move' ? ref : undefined, to, toX, toY, modifiers: Array.isArray(input.modifiers) ? input.modifiers : [],
        dy: dir === 'up' ? lines : dir === 'down' ? -lines : 0, dx: dir === 'right' ? lines : dir === 'left' ? -lines : 0,
      }));
    }
    case 'ands_type': {
      const r = await act({ verb: 'type_here', app: input.app, value: String(input.text ?? ''), why: input.why }, () => engine.typeHere(String(input.text ?? ''), input.app));
      engine.lastTyped = undefined;
      return r;
    }
    case 'ands_wait':
      return act({ verb: 'wait', app: input.app }, () => engine.wait({ ms: input.ms === undefined ? undefined : Number(input.ms), text: input.text ? String(input.text) : undefined, app: input.app }));
    case 'ands_press': {
      // Return is judged by the field it lands in: the one just typed into (from the screen, never from the model).
      const target = /^(return|enter)$/i.test(String(input.combo ?? '')) ? engine.lastTyped : undefined;
      const r = await act({ verb: 'press', app: input.app, value: input.combo, target, why: input.why }, () => engine.press(input.combo, input.app));
      engine.lastTyped = undefined;
      return r;
    }
    case 'ands_apps':
      if (input.action === 'list') return act({ verb: 'apps' }, () => engine.listApps());
      if (input.action === 'windows') return act({ verb: 'windows', app: input.app }, () => engine.listWindows(input.app));
      if (input.action === 'open') return act({ verb: 'launch', app: input.app, why: input.why }, () => engine.launch(input.app));
      if (input.action === 'quit') return act({ verb: 'close', app: input.app, why: input.why }, () => engine.closeApp(input.app));
      return { ok: false, text: 'action must be list, windows, open or quit' };
    case 'ands_clipboard':
      if (input.action === 'get') return act({ verb: 'clipboard_get', why: input.why }, () => engine.clipboardGet());
      return act({ verb: 'clipboard_set', value: input.text, why: input.why }, () => engine.clipboardSet(String(input.text ?? '')));
    case 'ands_screenshot': {
      let shot: Envelope | undefined;
      const r = await act({ verb: 'screenshot', app: input.app, why: input.why }, async () => (shot = await engine.screenshot(input.app)));
      const data = shot?.data?.data;
      if (r.ok && typeof data === 'string') {
        const fmt = String(shot?.data?.format ?? 'png').toLowerCase();
        return { ok: true, text: `screenshot ${shot?.data?.width}x${shot?.data?.height}`, image: { data, mimeType: fmt === 'jpeg' || fmt === 'jpg' ? 'image/jpeg' : 'image/png' } };
      }
      return r;
    }
  }
  return { ok: false, text: `Unknown tool ${name}` };
}
