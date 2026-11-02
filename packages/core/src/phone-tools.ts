// The phone's hands, as tools. Like tools.ts: every call builds an action from what the phone itself shows,
// asks the gate, and only then reaches the phone; every call is logged.
import { Gate, type Verdict } from './gate.ts';
import type { Action } from './policy.ts';
import { PhoneError, type Phone, type PhoneButton, type PhoneElement, type PhoneScreen, type Phones } from './phone.ts';
import type { Logger, ToolResult, ToolSpec } from './tools.ts';

const why = { type: 'string', description: 'One short sentence, for the person, on why this step is needed.' };
const phone = { type: 'string', description: 'Which phone, as ands_phones lists it. Leave out when only one is connected.' };

export const PHONE_TOOLS: ToolSpec[] = [
  { name: 'ands_phones', description: 'The person\'s own phones connected to this computer (Android over USB or Wi-Fi, iPhone over Wi-Fi), with their ids and whether each is ready. Use the phone tools when the job is on the phone: an app that exists only there (WhatsApp, a bank or delivery app, a code that arrived by SMS) or when the person asks.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'ands_phone_look', description: 'See the phone\'s screen: one line per element (role, "name", ref like p7, = value, [states], @x,y its center in tap points), and the app in front. Refs belong to that screen; look again after anything changes. text: only elements that contain it.',
    inputSchema: { type: 'object', properties: { phone, text: { type: 'string', description: 'Only elements whose name or value contains this' } } } },
  { name: 'ands_phone_tap', description: 'Tap an element from the last ands_phone_look (ref), or a point (x, y). hold:true is a long press. Tap a field before typing into it. Taps on send, pay, delete or install, and taps on a spot ands has not seen, wait for the person to approve.',
    inputSchema: { type: 'object', properties: { phone, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, hold: { type: 'boolean' }, why }, required: ['why'] } },
  { name: 'ands_phone_type', description: 'Type text into the field the phone\'s keyboard is in (tap the field first). submit:true presses Enter after it, which waits for approval unless the field is a search box, since Enter often sends.',
    inputSchema: { type: 'object', properties: { phone, text: { type: 'string' }, submit: { type: 'boolean' }, why }, required: ['text', 'why'] } },
  { name: 'ands_phone_swipe', description: 'Swipe like a finger. direction is the way the finger moves: up shows what is below (scrolls down), down shows what is above, left/right page sideways. From x, y (default the middle), for distance points (default 40% of the screen).',
    inputSchema: { type: 'object', properties: { phone, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, x: { type: 'number' }, y: { type: 'number' }, distance: { type: 'number' }, why }, required: ['direction', 'why'] } },
  { name: 'ands_phone_button', description: 'Press a phone button: home, back (Android), app_switcher (Android), or enter (waits for approval unless in a search box).',
    inputSchema: { type: 'object', properties: { phone, button: { type: 'string', enum: ['home', 'back', 'app_switcher', 'enter'] }, why }, required: ['button', 'why'] } },
  { name: 'ands_phone_apps', description: 'list: the apps installed on an Android phone (ids). open: open an app by its name ("WhatsApp") or id. current: which app is in front.',
    inputSchema: { type: 'object', properties: { phone, action: { type: 'string', enum: ['list', 'open', 'current'] }, app: { type: 'string' }, why }, required: ['action'] } },
  { name: 'ands_phone_screenshot', description: 'A picture of the phone\'s screen, for models that can see images. Prefer ands_phone_look. Asks the person first.',
    inputSchema: { type: 'object', properties: { phone, why } } },
];

export const isPhoneTool = (name: string) => PHONE_TOOLS.some((t) => t.name === name);

const NAME = 90;
const clip = (s: string, n = NAME) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const center = (e: PhoneElement) => ({ x: Math.round(e.x + e.width / 2), y: Math.round(e.y + e.height / 2) });

/** The phone's screen as short lines, the way the model reads the computer's. */
export function phoneLines(s: PhoneScreen, text?: string): string {
  const want = text?.toLowerCase();
  const els = want ? s.elements.filter((e) => `${e.name} ${e.value ?? ''}`.toLowerCase().includes(want)) : s.elements;
  const head = `phone app: ${s.app ?? 'unknown'}${s.width ? `, screen ${s.width}x${s.height}` : ''}`;
  const lines = els.slice(0, 400).map((e) => {
    const c = center(e);
    return [e.role, e.name ? `"${clip(e.name).replace(/"/g, "'")}"` : '', e.ref, e.value ? `= "${clip(e.value, 80).replace(/"/g, "'")}"` : '', e.states.length ? `[${e.states.join(', ')}]` : '', `@${c.x},${c.y}`].filter(Boolean).join(' ');
  });
  if (els.length > 400) lines.push(`…${els.length - 400} more: pass text to narrow`);
  if (!els.length) lines.push(want ? `nothing with "${text}" on the screen` : 'nothing readable on the screen (a game, a video, or a picture): use ands_phone_screenshot');
  return [head, ...lines].join('\n');
}

/** Runs one phone tool call: find the phone, build the action from its own screen, ask the gate, act, log. */
export async function runPhoneTool(name: string, input: any, ctx: { phones: Phones; gate: Gate; source: string; log?: Logger }): Promise<ToolResult> {
  const { phones, gate, source } = ctx;
  const log: Logger = ctx.log ?? (() => {});
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  try {
    if (name === 'ands_phones') {
      const v = await gate.check({ verb: 'phone_list' });
      if (!v.allowed) return { ok: false, text: `Not done: ${v.reason}` };
      const all = await phones.list();
      return { ok: true, text: all.length ? all.map((p) => `${p.platform === 'ios' ? 'iPhone' : 'Android'} "${p.name}" id ${p.id}: ${p.state}`).join('\n') : 'No phone is connected. Ask the person to connect one: https://ands.sh/en/phone' };
    }
    const ph: Phone = await phones.get(input.phone ? String(input.phone) : undefined);
    const key = ph.info.id;
    const seen = phones.seen.get(key);
    // The app in front, from the phone itself: what the do-not-touch list is checked against.
    const app = seen?.screen.app;

    const act = async (action: Action, run: () => Promise<string | void>): Promise<ToolResult> => {
      // The do-not-touch list is checked against the app in front right now, as the phone reports it.
      if (action.verb !== 'phone_launch') action.app = (await ph.foreground().catch(() => undefined)) ?? app;
      const v: Verdict = await gate.check(action);
      const target = action.target ? `${action.target.role}: ${action.target.name}` : action.ref;
      if (!v.allowed) {
        log({ task: gate.task, source, verb: action.verb, app: action.app, target, tier: v.tier, allowed: false, note: v.reason });
        return { ok: false, text: `Not done: ${v.reason} Ask the person what they want instead.` };
      }
      try {
        const text = await run();
        log({ task: gate.task, source, verb: action.verb, app: action.app, target, tier: v.tier, allowed: true, ok: true });
        return { ok: true, text: text || 'done. ands_phone_look to see the result.' };
      } catch (e: any) {
        log({ task: gate.task, source, verb: action.verb, app: action.app, target, tier: v.tier, allowed: true, ok: false, note: e?.code });
        throw e;
      }
    };

    switch (name) {
      case 'ands_phone_look': {
        // A look is read, but the app it lands in is checked too: nothing is read out of a do-not-touch app.
        const s = await ph.screen();
        const v = await gate.check({ verb: 'phone_look', app: s.app });
        if (!v.allowed) { log({ task: gate.task, source, verb: 'phone_look', app: s.app, tier: v.tier, allowed: false, note: v.reason }); return { ok: false, text: `Not done: ${v.reason}` }; }
        phones.seen.set(key, { screen: s });
        log({ task: gate.task, source, verb: 'phone_look', app: s.app, tier: v.tier, allowed: true, ok: true });
        return { ok: true, text: phoneLines(s, input.text ? String(input.text) : undefined) };
      }
      case 'ands_phone_tap': {
        const ref = input.ref ? String(input.ref).replace(/^@/, '') : undefined;
        let el = ref ? seen?.screen.elements.find((e) => e.ref === ref) : undefined;
        if (ref && !el) return { ok: false, text: `No ${ref} on the last screen. ands_phone_look again.` };
        let [x, y] = [num(input.x), num(input.y)];
        if (el) ({ x, y } = center(el));
        else if (x === undefined || y === undefined) return { ok: false, text: 'Pass a ref from ands_phone_look, or x and y.' };
        // A point is judged by the smallest element under it on the last screen (from the phone, never the model).
        el ??= under(seen?.screen, x!, y!);
        const verb = input.hold ? 'phone_long_press' : 'phone_tap';
        return await act({ verb, app, ref: el?.ref, target: el ? { role: el.role, name: el.name } : undefined, value: `${Math.round(x!)},${Math.round(y!)}`, why: input.why }, async () => {
          await ph.tap(x!, y!, input.hold ? 800 : undefined);
          const s = phones.seen.get(key);
          if (s) s.lastTapped = el;
        });
      }
      case 'ands_phone_type': {
        const text = String(input.text ?? '');
        const field = seen?.lastTapped;
        const target = field ? { role: field.role, name: field.name } : undefined;
        const r = await act({ verb: 'phone_type', app, target, value: text, why: input.why }, () => ph.type(text));
        if (!r.ok || !input.submit) return r;
        return await act({ verb: 'phone_enter', app, target, why: input.why }, () => ph.button('enter'));
      }
      case 'ands_phone_swipe': {
        const dir = String(input.direction ?? 'up');
        if (!['up', 'down', 'left', 'right'].includes(dir)) return { ok: false, text: 'direction must be up, down, left or right' };
        const size = seen?.screen.width ? { width: seen.screen.width, height: seen.screen.height! } : await ph.size();
        const x = num(input.x) ?? size.width / 2;
        const y = num(input.y) ?? size.height / 2;
        const d = num(input.distance) ?? (dir === 'up' || dir === 'down' ? size.height : size.width) * 0.4;
        const [dx, dy] = dir === 'up' ? [0, -d] : dir === 'down' ? [0, d] : dir === 'left' ? [-d, 0] : [d, 0];
        return await act({ verb: 'phone_swipe', app, value: dir, why: input.why }, () => ph.swipe(x, y, x + dx, y + dy, 300));
      }
      case 'ands_phone_button': {
        const b = String(input.button ?? '') as PhoneButton;
        if (!['home', 'back', 'app_switcher', 'enter'].includes(b)) return { ok: false, text: 'button must be home, back, app_switcher or enter' };
        const field = seen?.lastTapped;
        if (b === 'enter') return await act({ verb: 'phone_enter', app, target: field ? { role: field.role, name: field.name } : undefined, why: input.why }, () => ph.button('enter'));
        return await act({ verb: 'phone_button', app, value: b, why: input.why }, () => ph.button(b));
      }
      case 'ands_phone_apps': {
        if (input.action === 'list') return await act({ verb: 'phone_apps' }, async () => (await ph.apps()).join('\n'));
        if (input.action === 'current') return await act({ verb: 'phone_current' }, async () => `${await ph.foreground() ?? 'unknown'}`);
        if (input.action === 'open') {
          if (!input.app) return { ok: false, text: 'Pass app: its name or id.' };
          return await act({ verb: 'phone_launch', app: String(input.app), why: input.why }, () => ph.launch(String(input.app)));
        }
        return { ok: false, text: 'action must be list, open or current' };
      }
      case 'ands_phone_screenshot': {
        let shot: { data: string; mimeType: string } | undefined;
        const r = await act({ verb: 'phone_screenshot', app, why: input.why }, async () => { shot = await ph.screenshot(); return 'phone screenshot'; });
        return r.ok && shot ? { ...r, image: shot } : r;
      }
    }
    return { ok: false, text: `Unknown tool ${name}` };
  } catch (e: any) {
    // Anything else (an approval that has to come from the person's phone, NeedsOk) goes up to the caller.
    if (e instanceof PhoneError) return { ok: false, text: `${e.code}: ${e.message}` };
    throw e;
  }
}

/** The smallest element whose box holds the point. */
function under(s: PhoneScreen | undefined, x: number, y: number): PhoneElement | undefined {
  let best: PhoneElement | undefined;
  for (const e of s?.elements ?? []) {
    if (x < e.x || y < e.y || x > e.x + e.width || y > e.y + e.height) continue;
    if (!best || e.width * e.height < best.width * best.height) best = e;
  }
  return best;
}
