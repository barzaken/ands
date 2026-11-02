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
const QUIET_STATES = new Set(['enabled', 'visible', 'focusable', 'showing']);

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
export const shortRef = (ref: string) => ref.slice(ref.lastIndexOf(':') + 1);

/** One element as a line, or undefined for a wrapper with nothing to say. */
function line(n: any): string | undefined {
  const role = String(n.role ?? '');
  const name = clip(n.name, NAME);
  const desc = clip(n.description, NAME);
  const ref = typeof n.ref_id === 'string' ? shortRef(n.ref_id) : '';
  if (!ref && !name && !n.subtree_truncated && n.children_count === undefined) return undefined;
  const parts = [role || 'item'];
  if (name) parts.push(q(name));
  if (desc && desc !== name) parts.push(`(${desc})`);
  if (ref) parts.push(ref);
  if (n.value !== undefined && n.value !== null && String(n.value) !== '' && String(n.value) !== name) parts.push(`= ${q(clip(n.value, VALUE))}`);
  const states = (Array.isArray(n.states) ? n.states : []).filter((s: string) => !QUIET_STATES.has(s));
  if (states.length) parts.push(`[${states.join(', ')}]`);
  if (typeof n.children_count === 'number' && !(n.children ?? []).length) parts.push(`(${n.children_count} more inside${ref ? `: look with root:${ref}` : ''})`);
  else if (n.subtree_truncated) parts.push(`(more inside${ref ? `: look with root:${ref}` : ''})`);
  return parts.join(' ');
}

function walk(n: any, depth: number, out: string[]) {
  if (!n || typeof n !== 'object') return;
  const l = line(n);
  if (l) out.push('  '.repeat(depth) + l);
  for (const c of n.children ?? []) walk(c, l ? depth + 1 : depth, out);
}

/** A snapshot as short lines. */
export function compactScreen(data: any): string {
  const out: string[] = [];
  const head = [data?.app, data?.window?.title && data.window.title !== data.app ? `window ${q(clip(data.window.title, NAME))}` : ''].filter(Boolean).join(', ');
  if (head) out.push(head);
  walk(data?.tree, 0, out);
  if (data?.complete === false) out.push('(This screen was cut: look with text:"…" for what you need, or skeleton:true and then root.)');
  return out.join('\n');
}

/** The matches of a find, as short lines. */
export function compactMatches(data: any): string {
  const ms: any[] = Array.isArray(data?.matches) ? data.matches : [];
  if (!ms.length) return 'No element matches.';
  return ms.map((m) => line(m) ?? `${m.role ?? 'text'} ${q(clip(m.name ?? m.text, NAME))}`).join('\n');
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
