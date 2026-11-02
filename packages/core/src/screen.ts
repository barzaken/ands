// What the model reads of a screen. The engine's snapshot is JSON with every element's actions, native
// ids, bounds and descriptions: about 250 characters per button, and most of a model turn's time went into
// reading it. Here each element is one short line, indented under the named groups it sits in:
//
//   button "Back" e1
//   textfield "Address and search bar" e5 = "youtube.com" [focused]
//
// Refs are shown short (e5); Engine.full turns them back into the snapshot's qualified refs.

const NAME = 90;
const VALUE = 80;
/** Reading a page (search results, an email, an article): texts come back whole enough to read. */
const READ_TEXT = 600;
/** A match of a find is one line, so it can afford a longer name (a search result's title and site). */
const MATCH_NAME = 200;
export type ScreenOptions = { read?: boolean; bounds?: boolean };
type Clip = { name: number; value: number; bounds?: boolean };
const QUIET_STATES = new Set(['enabled', 'visible', 'focusable', 'showing']);

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
export const shortRef = (ref: string) => ref.slice(ref.lastIndexOf(':') + 1);

/** One element as a line, or undefined for a wrapper with nothing to say. */
function line(n: any, c: Clip = { name: NAME, value: VALUE }): string | undefined {
  const role = String(n.role ?? '');
  const name = clip(n.name, c.name);
  const desc = clip(n.description, c.name);
  const ref = typeof n.ref_id === 'string' ? shortRef(n.ref_id) : '';
  if (!ref && !name && !n.subtree_truncated && n.children_count === undefined) return undefined;
  const parts = [role || 'item'];
  if (name) parts.push(q(name));
  if (desc && desc !== name) parts.push(`(${desc})`);
  if (ref) parts.push(ref);
  if (n.value !== undefined && n.value !== null && String(n.value) !== '' && String(n.value) !== name) parts.push(`= ${q(clip(n.value, c.value))}`);
  const states = (Array.isArray(n.states) ? n.states : []).filter((s: string) => !QUIET_STATES.has(s));
  if (states.length) parts.push(`[${states.join(', ')}]`);
  const b = box(n.bounds);
  if (c.bounds && b) parts.push(`@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`);
  if (typeof n.children_count === 'number' && !(n.children ?? []).length) parts.push(`(${n.children_count} more inside${ref ? `: look with root:${ref}` : ''})`);
  else if (n.subtree_truncated) parts.push(`(more inside${ref ? `: look with root:${ref}` : ''})`);
  return parts.join(' ');
}

function box(b: any): { x: number; y: number; width: number; height: number } | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const [x, y, width, height] = [b.x, b.y, b.width ?? b.w, b.height ?? b.h].map(Number);
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : undefined;
}

function walk(n: any, depth: number, out: string[], c: Clip) {
  if (!n || typeof n !== 'object') return;
  const l = line(n, c);
  if (l) out.push('  '.repeat(depth) + l);
  for (const k of n.children ?? []) walk(k, l ? depth + 1 : depth, out, c);
}

/** A snapshot as short lines. `read`: every text, long enough to read; `bounds`: where each element is. */
export function compactScreen(data: any, o: ScreenOptions = {}): string {
  const c: Clip = o.read ? { name: READ_TEXT, value: READ_TEXT, bounds: o.bounds } : { name: NAME, value: VALUE, bounds: o.bounds };
  const out: string[] = [];
  const head = [data?.app, data?.window?.title && data.window.title !== data.app ? `window ${q(clip(data.window.title, NAME))}` : ''].filter(Boolean).join(', ');
  if (head) out.push(head);
  walk(data?.tree, 0, out, c);
  if (data?.complete === false) out.push('(This screen was cut: look with text:"…" for what you need, or skeleton:true and then root.)');
  return out.join('\n');
}

/** The matches of a find, as short lines. */
export function compactMatches(data: any, o: ScreenOptions = {}): string {
  const ms: any[] = Array.isArray(data?.matches) ? data.matches : [];
  if (!ms.length) return 'No element matches.';
  const c: Clip = { name: MATCH_NAME, value: MATCH_NAME, bounds: o.bounds };
  return ms.map((m) => line(m, c) ?? `${m.role ?? 'text'} ${q(clip(m.name ?? m.text, MATCH_NAME))}`).join('\n');
}

/** Keys of an action's answer that only help when debugging the engine. */
const NOISE = new Set(['native_id', 'available_actions', 'process_instance', 'pid', 'auto_wait', 'lease_contention_count', 'lease_hold_ms', 'read_only_preflight_attempts', 'read_only_resolve_attempts', 'steps', 'bounds', 'path', 'interactive']);
/** Any other answer, without the engine's bookkeeping. */
export function quiet(v: any): any {
  if (Array.isArray(v)) return v.map(quiet);
  if (!v || typeof v !== 'object') return v;
  const o: any = {};
  for (const [k, x] of Object.entries(v)) if (!NOISE.has(k)) o[k] = quiet(x);
  return o;
}
