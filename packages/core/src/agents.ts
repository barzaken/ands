// Several agents at once on one computer. They share one engine session, and each agent in it gets its
// own cursor on the screen. They work in the background (headless, through accessibility), so the person
// can keep using the computer; a step that needs the real keyboard or pointer waits its turn for the
// shared hands (see Engine.hands). Every agent's steps still go through the same Gate.
import { Engine, serial, type Lock, type Runner } from './engine.ts';

/** The `agent` argument outside agents pass to give each independent job its own cursor. */
export const AGENT_PARAM = {
  type: 'string',
  description: 'A short name for the job this step belongs to, e.g. "mail-pdfs". To do several independent jobs at once (for example one per subagent), give each its own name: each gets its own cursor and they work in parallel, in the background, while the person keeps using the computer. Steps that depend on each other share one name.',
};

/** An engine agent id: 1-64 letters, digits, - or _. */
export function agentId(name?: string): string {
  const raw = String(name ?? '').trim();
  if (!raw) return 'main';
  const id = raw.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (id) return id;
  // A name in another script ("מייל") still gets an id of its own.
  let h = 0;
  for (const c of raw) h = (Math.imul(h, 31) + c.codePointAt(0)!) >>> 0;
  return `agent-${h.toString(36)}`;
}

export class Agents {
  run: Runner;
  /** Flags for `cursor-overlay enable`, e.g. an image and colours. */
  style: string[];
  hands: Lock = serial();
  private started?: Promise<string | undefined>;
  private multi = false;
  private engines = new Map<string, Promise<Engine>>();

  constructor(run: Runner, o: { style?: string[] } = {}) {
    this.run = run;
    this.style = o.style ?? [];
  }

  /** The shared session, started on first use with one cursor per agent. Undefined when the engine has none. */
  session(): Promise<string | undefined> {
    return (this.started ??= (async () => {
      const e = await this.run(['session', 'start', '--no-trace', '--name', 'ands']).catch(() => undefined);
      const sid = e?.ok && typeof e.data?.session_id === 'string' ? e.data.session_id : undefined;
      if (!sid) return undefined;
      const on = await this.run(['--session', sid, 'cursor-overlay', 'enable', '--multi-agent', ...this.style]).catch(() => undefined);
      // Without per-agent cursors the agents still share the session; they just have no cursor of their own.
      this.multi = !!on?.ok;
      return sid;
    })());
  }

  /** The engine for one agent: its own cursor (labelled, when `label` is given) and its own refs. */
  engine(name?: string, label?: string): Promise<Engine> {
    const id = agentId(name);
    let e = this.engines.get(id);
    if (!e) {
      e = (async () => {
        const sid = await this.session();
        if (!sid) return new Engine(this.run, [], { hands: this.hands, background: id !== 'main' });
        const globals = this.multi ? ['--session', sid, '--agent-id', id] : ['--session', sid];
        const text = (label ?? (id === 'main' ? '' : String(name))).trim();
        if (this.multi) await this.run([...globals, 'cursor-overlay', 'enable', ...this.style, ...(text ? ['--label', text] : [])]).catch(() => undefined);
        return new Engine(this.run, globals, { hands: this.hands, background: id !== 'main' });
      })();
      this.engines.set(id, e);
    }
    return e;
  }

  /** Forget one agent's engine (its cursor stays until the session ends). */
  done(name?: string) { this.engines.delete(agentId(name)); }

  /** Ends the session, which removes every agent's cursor. */
  async end() {
    const sid = await this.started;
    this.started = undefined;
    this.engines.clear();
    if (sid) await this.run(['session', 'end', sid]).then(() => this.run(['session', 'gc', '--ended'])).catch(() => undefined);
  }
}
