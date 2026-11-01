// The hands, as tools. One definition serves the MCP server (for outside agents) and the agent's own loop.
// Every call goes through the gate before it reaches the engine, and every call is logged.
import type { Engine, Envelope } from './engine.ts';
import { Gate, type Verdict } from './gate.ts';
import type { Action } from './policy.ts';

export type ToolSpec = { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] } };

const why = { type: 'string', description: 'One short sentence, for the person, on why this step is needed.' };

export const TOOLS: ToolSpec[] = [
  { name: 'ands_look', description: 'See an app: returns its window as an accessibility tree in JSON, with a ref (like @s8f3k2p9:e8) for every element you can act on. Refs belong to that snapshot; look again after the screen changes. To find one thing (a "Download" button, a file name), pass text: only matching elements come back, which is much faster. For dense apps pass skeleton:true first, then root:<ref> to drill in.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App name exactly as ands_apps lists it, e.g. "Safari", "Google Chrome", "Finder". Never translate it into the person\'s language.' }, window_id: { type: 'string' }, text: { type: 'string', description: 'Only elements whose name or text contains this, e.g. "Download"' }, role: { type: 'string', description: 'With text: only this kind of element, e.g. "button", "link"' }, root: { type: 'string', description: 'Ref to start from' }, skeleton: { type: 'boolean' } } } },
  { name: 'ands_act', description: 'Do one thing to an element from your last ands_look: click, double-click, right-click, type, set-value, select, toggle, check, uncheck, scroll, scroll-to, focus, clear, expand, collapse. Look again afterwards to confirm it worked. Steps that send, pay, delete or install wait for the person to approve.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'double-click', 'right-click', 'type', 'set-value', 'select', 'toggle', 'check', 'uncheck', 'scroll', 'scroll-to', 'focus', 'clear', 'expand', 'collapse'] }, ref: { type: 'string' }, value: { type: 'string', description: 'Text for type/set-value, option for select, direction for scroll' }, app: { type: 'string' }, why }, required: ['action', 'ref', 'why'] } },
  { name: 'ands_press', description: 'Press a key or shortcut, e.g. "return", "escape", "cmd+c", "ctrl+shift+t". Return right after typing into a search or address field just searches; elsewhere Return waits for approval because it often sends or submits.',
    inputSchema: { type: 'object', properties: { combo: { type: 'string' }, app: { type: 'string' }, why }, required: ['combo', 'why'] } },
  { name: 'ands_apps', description: 'List running apps or their windows, open an app, or quit one.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'windows', 'open', 'quit'] }, app: { type: 'string' }, why }, required: ['action'] } },
  { name: 'ands_clipboard', description: 'Read or set the clipboard. Reading asks the person first, since it may hold private text.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'set'] }, text: { type: 'string' }, why }, required: ['action'] } },
  { name: 'ands_screenshot', description: 'A picture of the screen or one app, for models that can see images. Prefer ands_look: it is faster and gives refs. Asks the person first.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, why } } },
];

export type ToolResult = { ok: boolean; text: string; image?: { data: string; mimeType: string } };

const MAX = 40_000;
const shown = (e: Envelope) => {
  const s = JSON.stringify(e.ok ? e.data : e.error);
  return s.length > MAX ? s.slice(0, MAX) + '…(cut: look at a smaller root)' : s;
};

/** Runs one tool call: build the action, ask the gate, run the engine, log. */
/** One line of the action log. Typed values are never written: only that something was typed. */
export type LogEntry = { at: string; task?: string; source: string; verb: string; app?: string; target?: string; tier: string; allowed: boolean; ok?: boolean; note?: string };
export type Logger = (e: Omit<LogEntry, 'at'>) => void;

export async function runTool(name: string, input: any, ctx: { engine: Engine; gate: Gate; source: string; log?: Logger }): Promise<ToolResult> {
  const { engine, gate, source } = ctx;
  const log: Logger = ctx.log ?? (() => {});
  const act = async (action: Action, run: () => Promise<Envelope>): Promise<ToolResult> => {
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
      const hint = e.error?.code === 'APP_NOT_FOUND' ? ' Use the app name exactly as ands_apps lists it (e.g. "Calculator", not a translation).' : '';
      return { ok: false, text: `${e.error?.code}: ${e.error?.message}${e.error?.suggestion ? ` Suggestion: ${e.error.suggestion}` : ''}${details}${hint}` };
    }
    return { ok: true, text: shown(e) };
  };

  switch (name) {
    case 'ands_look': {
      if (input.text) return act({ verb: 'find', app: input.app }, () => engine.find({ app: input.app, windowId: input.window_id, text: String(input.text), role: input.role }));
      const r = await act({ verb: 'look', app: input.app }, () => engine.snapshot({ app: input.app, windowId: input.window_id, root: input.root, skeleton: input.skeleton }));
      // A tree the engine could not finish in time (a big web page) says so, so the model narrows instead of guessing.
      if (r.ok && /"complete":false/.test(r.text)) r.text += ' (This screen was cut: look with text:"…" for what you need, or skeleton:true and then root.)';
      return r;
    }
    case 'ands_act': {
      const verb = String(input.action);
      const extra = verb === 'scroll' && input.value ? ['--direction', String(input.value)] : [];
      const value = ['type', 'set-value', 'select'].includes(verb) ? String(input.value ?? '') : undefined;
      const target = engine.refs.get(input.ref);
      const r = await act({ verb: verb === 'set-value' ? 'set_value' : verb, app: input.app, ref: input.ref, target, value, why: input.why },
        () => engine.act(verb, input.ref, value, extra));
      if (r.ok) engine.lastTyped = verb === 'type' || verb === 'set-value' ? target : undefined;
      return r;
    }
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
