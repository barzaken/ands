// The person's own phone, as hands. Android is driven over adb (USB, or Wi-Fi after pairing); an iPhone
// through WebDriverAgent, the open-source test runner Apple's XCTest drives (BSD-3, from Appium), installed
// on the phone once from a Mac. Nothing goes through a cloud: the phone talks to this computer only.
// This file runs anywhere (Node and the desktop app's window). How an adb command reaches the binary is
// the AdbRunner's job (phone-node.ts spawns it; the desktop app asks its Rust side), and the iPhone is
// reached with an Http function (fetch by default).

/** One adb command. `out` is stdout as text, or as base64 when `binary` is set (a screenshot). */
export type AdbResult = { ok: boolean; out: string; code?: string; message?: string };
export type AdbRunner = (args: string[], o?: { timeoutMs?: number; binary?: boolean }) => Promise<AdbResult>;
export type Http = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) => Promise<{ status: number; json: any }>;

export const fetchHttp: Http = async (method, url, body) => {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
};

export type PhoneInfo = { id: string; platform: 'android' | 'ios'; name: string; state: 'ready' | 'unauthorized' | 'offline' | 'unreachable' };

/** One thing on the phone's screen. x, y, width, height are in the points taps use. */
export type PhoneElement = { ref: string; role: string; name: string; value?: string; states: string[]; x: number; y: number; width: number; height: number };
export type PhoneScreen = { app?: string; width?: number; height?: number; elements: PhoneElement[] };
export type PhoneButton = 'home' | 'back' | 'app_switcher' | 'enter';

/** A phone ands can drive. Every method is one step; the gate is asked before each in runPhoneTool. */
export interface Phone {
  info: PhoneInfo;
  screen(): Promise<PhoneScreen>;
  size(): Promise<{ width: number; height: number }>;
  tap(x: number, y: number, holdMs?: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms?: number): Promise<void>;
  type(text: string): Promise<void>;
  button(b: PhoneButton): Promise<void>;
  apps(): Promise<string[]>;
  launch(app: string): Promise<void>;
  foreground(): Promise<string | undefined>;
  screenshot(): Promise<{ data: string; mimeType: string }>;
}

export class PhoneError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

// ---------- Android ----------

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

const ANDROID_ROLES: Record<string, string> = {
  Button: 'button', ImageButton: 'button', EditText: 'textfield', AutoCompleteTextView: 'textfield', TextView: 'text', ImageView: 'image',
  CheckBox: 'checkbox', Switch: 'switch', ToggleButton: 'switch', RadioButton: 'radio', CheckedTextView: 'checkbox', SeekBar: 'slider',
  Spinner: 'popup', ProgressBar: 'progress', WebView: 'webview', RecyclerView: 'list', ListView: 'list', ScrollView: 'scroll', TabWidget: 'tabs',
};

/** The screen from `uiautomator dump`: every node with something to say or to tap, as one element. */
export function parseUiautomator(xml: string): PhoneScreen {
  const elements: PhoneElement[] = [];
  const packages = new Map<string, number>();
  let n = 0;
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a: Record<string, string> = {};
    for (const p of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[p[1]] = decode(p[2]);
    if (a.package) packages.set(a.package, (packages.get(a.package) ?? 0) + 1);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds ?? '');
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    const cls = (a.class ?? '').split('.').pop() ?? '';
    const yes = (k: string) => a[k] === 'true';
    const name = (a.text || a['content-desc'] || '').trim();
    const editable = /EditText|AutoComplete/.test(cls);
    if (!name && !yes('clickable') && !yes('long-clickable') && !yes('checkable') && !editable && !yes('scrollable')) continue;
    const states = [
      yes('clickable') && 'tappable', yes('long-clickable') && 'long-press', yes('scrollable') && 'scrollable', yes('checked') && 'checked',
      yes('selected') && 'selected', yes('focused') && 'focused', a.enabled === 'false' && 'disabled', yes('password') && 'password',
    ].filter(Boolean) as string[];
    let role = ANDROID_ROLES[cls] ?? (yes('clickable') ? 'button' : cls.toLowerCase() || 'item');
    if (yes('clickable') && (role === 'text' || role === 'image')) role = 'button';
    if (yes('password')) role = 'securetextfield';
    const id = (a['resource-id'] ?? '').split('/').pop() ?? '';
    elements.push({ ref: `p${++n}`, role, name: name || (editable || yes('clickable') ? id.replace(/_/g, ' ') : ''), value: editable && a.text ? a.text : undefined, states, x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  }
  // The app in front is the one most of the screen belongs to (the status bar is com.android.systemui).
  const app = [...packages].filter(([p]) => p !== 'com.android.systemui').sort((x, y) => y[1] - x[1])[0]?.[0];
  return { app, elements };
}

/** `adb devices -l`: each line a serial, a state and its details. */
export function parseAdbDevices(out: string): PhoneInfo[] {
  const list: PhoneInfo[] = [];
  for (const l of out.split('\n')) {
    const m = /^(\S+)\s+(device|unauthorized|offline|authorizing|no permissions)\b(.*)$/.exec(l.trim());
    if (!m) continue;
    const model = /model:(\S+)/.exec(m[3])?.[1]?.replace(/_/g, ' ');
    list.push({ id: m[1], platform: 'android', name: model ?? m[1], state: m[2] === 'device' ? 'ready' : m[2] === 'unauthorized' || m[2] === 'no permissions' ? 'unauthorized' : 'offline' });
  }
  return list;
}

/** Text as `adb shell input text` takes it. It only types what an English keyboard can. */
export function adbText(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(text)) throw new PhoneError('TYPE_UNSUPPORTED', 'This Android phone can only be typed English letters, digits and symbols over adb. For other languages, ask the person to type it, or paste it: put the text somewhere it can be copied from, long-press the field and tap Paste.');
  // Spaces become %s, and every shell character is escaped (the text runs through the phone's shell).
  return text.replace(/([\\'"`$&|;<>()*?!#~{}\[\]^])/g, '\\$1').replace(/ /g, '%s');
}

const KEYS: Record<PhoneButton, string> = { home: '3', back: '4', app_switcher: '187', enter: '66' };

export class AndroidPhone implements Phone {
  info: PhoneInfo;
  adb: AdbRunner;
  constructor(info: PhoneInfo, adb: AdbRunner) { this.info = info; this.adb = adb; }

  async run(args: string[], o: { timeoutMs?: number; binary?: boolean } = {}): Promise<string> {
    const r = await this.adb(['-s', this.info.id, ...args], o);
    if (!r.ok) throw new PhoneError(r.code ?? 'ADB_FAILED', r.message ?? r.out.slice(0, 500));
    return r.out;
  }
  shell(cmd: string) { return this.run(['shell', cmd]); }

  async screen(): Promise<PhoneScreen> {
    const f = '/data/local/tmp/ands-ui.xml';
    const xml = await this.run(['exec-out', `uiautomator dump --compressed ${f} >/dev/null 2>&1; cat ${f}; rm -f ${f}`], { timeoutMs: 20_000 });
    if (!xml.includes('<hierarchy')) throw new PhoneError('SCREEN_FAILED', 'The phone did not return its screen. Unlock it, keep it awake, and try again.');
    const s = parseUiautomator(xml);
    const size = await this.size().catch(() => undefined);
    return { ...s, ...size };
  }
  async size() {
    const out = await this.shell('wm size');
    const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
    if (!m) throw new PhoneError('SCREEN_FAILED', 'Could not read the screen size.');
    return { width: Number(m[1]), height: Number(m[2]) };
  }
  async tap(x: number, y: number, holdMs?: number) {
    const [a, b] = [Math.round(x), Math.round(y)];
    await this.shell(holdMs ? `input swipe ${a} ${b} ${a} ${b} ${Math.round(holdMs)}` : `input tap ${a} ${b}`);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300) {
    await this.shell(`input swipe ${[x1, y1, x2, y2].map(Math.round).join(' ')} ${Math.round(ms)}`);
  }
  async type(text: string) {
    // Long text in pieces: the phone's input command drops characters past a few hundred.
    for (let i = 0; i < text.length; i += 200) await this.shell(`input text ${adbText(text.slice(i, i + 200))}`);
  }
  async button(b: PhoneButton) { await this.shell(`input keyevent ${KEYS[b]}`); }
  async apps() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort();
  }
  /** By package id (com.whatsapp), or by a name that is part of one ("WhatsApp"). */
  async launch(app: string) {
    let pkg = app.trim();
    if (!/^[\w]+(\.[\w]+)+$/.test(pkg)) {
      const word = pkg.toLowerCase().replace(/[^a-z0-9]/g, '');
      const all = (await this.shell('pm list packages')).split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
      const hit = word ? all.filter((p) => p.toLowerCase().replace(/[^a-z0-9.]/g, '').split('.').some((part) => part === word)) : [];
      const found = hit[0] ?? (word ? all.find((p) => p.toLowerCase().includes(word)) : undefined);
      if (!found) throw new PhoneError('APP_NOT_FOUND', `No app called "${app}" on the phone. ands_phone_apps lists them by id; pass the id.`);
      pkg = found;
    }
    const out = await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found|aborted/i.test(out)) throw new PhoneError('APP_NOT_FOUND', `${pkg} cannot be opened from the home screen.`);
  }
  async foreground() {
    const out = await this.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
    return /\s([\w.]+)\/[\w.$]+/.exec(out)?.[1];
  }
  async screenshot() {
    return { data: await this.run(['exec-out', 'screencap -p'], { binary: true, timeoutMs: 20_000 }), mimeType: 'image/png' };
  }
}

// ---------- iPhone (WebDriverAgent) ----------

const IOS_ROLES: Record<string, string> = {
  Button: 'button', TextField: 'textfield', SecureTextField: 'securetextfield', SearchField: 'searchfield', StaticText: 'text', Link: 'link',
  Image: 'image', Switch: 'switch', Cell: 'cell', Icon: 'app', TextView: 'textarea', Slider: 'slider', Tab: 'tab', Key: 'key',
  NavigationBar: 'toolbar', Alert: 'alert', SegmentedControl: 'tabs', PickerWheel: 'picker', Keyboard: 'keyboard',
};

/** The screen from WebDriverAgent's /source?format=json. */
export function parseWdaSource(tree: any): PhoneScreen {
  const elements: PhoneElement[] = [];
  let n = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const type = String(node.type ?? '').replace(/^XCUIElementType/, '');
    const r = node.rect ?? node.frame ?? {};
    const [x, y, width, height] = [r.x, r.y, r.width, r.height].map(Number);
    const name = String(node.label || node.name || '').trim();
    const role = IOS_ROLES[type] ?? type.toLowerCase();
    const worth = name || ['TextField', 'SecureTextField', 'SearchField', 'TextView', 'Button', 'Switch', 'Cell', 'Key'].includes(type);
    const visible = node.isVisible !== false && node.isVisible !== '0' && width > 0 && height > 0;
    const kept = worth && visible && !['Window', 'Application', 'Keyboard', 'Key'].includes(type) && (type !== 'Other' || (name && !node.children?.length));
    if (kept) {
      const value = node.value !== undefined && node.value !== null && String(node.value) !== name ? String(node.value) : undefined;
      const states = [node.isEnabled === false || node.isEnabled === '0' ? 'disabled' : '', node.isFocused ? 'focused' : '', value === '1' && type === 'Switch' ? 'on' : ''].filter(Boolean);
      elements.push({ ref: `p${++n}`, role, name, value: type === 'SecureTextField' ? undefined : value, states, x, y, width, height });
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  return { elements };
}

export class IosPhone implements Phone {
  info: PhoneInfo;
  url: string;
  http: Http;
  private session?: string;
  constructor(url: string, http: Http = fetchHttp, name?: string) {
    this.url = url.replace(/\/+$/, '');
    this.http = http;
    this.info = { id: this.url, platform: 'ios', name: name ?? 'iPhone', state: 'ready' };
  }

  async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<any> {
    let r: { status: number; json: any };
    try { r = await this.http(method, `${this.url}${path}`, body); }
    catch (e: any) { throw new PhoneError('PHONE_UNREACHABLE', `Could not reach the iPhone at ${this.url} (${e?.message ?? e}). Is it on the same Wi-Fi, unlocked, with WebDriverAgent running?`); }
    const err = r.json?.value?.error;
    if (r.status >= 400 || err) {
      if (/invalid session/i.test(String(err))) this.session = undefined;
      throw new PhoneError('PHONE_FAILED', String(r.json?.value?.message ?? err ?? `HTTP ${r.status}`).slice(0, 500));
    }
    return r.json?.value;
  }
  async sid(): Promise<string> {
    if (this.session) return this.session;
    const v = await this.call('POST', '/session', { capabilities: { alwaysMatch: {} } });
    this.session = String(v?.sessionId ?? '');
    if (!this.session) throw new PhoneError('PHONE_FAILED', 'WebDriverAgent did not start a session.');
    return this.session;
  }
  /** Taps and swipes as one finger, in W3C actions (points, like the screen's rects). */
  async finger(steps: any[]) {
    await this.call('POST', `/session/${await this.sid()}/actions`, { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: steps }] });
  }

  async screen(): Promise<PhoneScreen> {
    await this.sid();
    const tree = await this.call('GET', '/source?format=json');
    const s = parseWdaSource(tree);
    const app = await this.foreground().catch(() => undefined);
    const size = await this.size().catch(() => undefined);
    return { ...s, app, ...size };
  }
  async size() {
    const v = await this.call('GET', `/session/${await this.sid()}/window/size`);
    return { width: Number(v?.width), height: Number(v?.height) };
  }
  async tap(x: number, y: number, holdMs = 80) {
    await this.finger([{ type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: Math.round(holdMs) }, { type: 'pointerUp', button: 0 }]);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300) {
    await this.finger([{ type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 50 }, { type: 'pointerMove', duration: Math.round(ms), x: Math.round(x2), y: Math.round(y2) }, { type: 'pointerUp', button: 0 }]);
  }
  async type(text: string) { await this.call('POST', `/session/${await this.sid()}/wda/keys`, { value: [...text] }); }
  async button(b: PhoneButton) {
    if (b === 'home') return void (await this.call('POST', '/wda/homescreen'));
    if (b === 'enter') return this.type('\n');
    if (b === 'back') throw new PhoneError('NO_SUCH_BUTTON', 'An iPhone has no Back button. Tap the app\'s own back arrow (usually top left), or swipe right from the left edge.');
    throw new PhoneError('NO_SUCH_BUTTON', 'To switch apps on an iPhone, open the app by name with ands_phone_apps.');
  }
  async apps(): Promise<string[]> {
    throw new PhoneError('NOT_SUPPORTED', 'An iPhone does not list its apps to ands. Open one by name with ands_phone_apps action:open.');
  }
  /** By bundle id (com.apple.mobilesafari), or by name through Spotlight, as a person would. */
  async launch(app: string) {
    if (/^[\w-]+(\.[\w-]+){2,}$/.test(app)) return void (await this.call('POST', `/session/${await this.sid()}/wda/apps/launch`, { bundleId: app }));
    await this.button('home');
    const { width, height } = await this.size();
    await this.swipe(width / 2, height * 0.35, width / 2, height * 0.6, 250);
    await new Promise((r) => setTimeout(r, 600));
    await this.type(`${app}\n`);
  }
  async foreground() {
    const v = await this.call('GET', '/wda/activeAppInfo');
    return v?.bundleId ? String(v.bundleId) : undefined;
  }
  async screenshot() { return { data: String(await this.call('GET', '/screenshot')), mimeType: 'image/png' }; }
}

// ---------- All the phones ----------

export class Phones {
  adb?: AdbRunner;
  http: Http;
  /** WebDriverAgent addresses of the person's iPhones, e.g. http://192.168.1.20:8100. */
  iphones: string[];
  private ios = new Map<string, IosPhone>();
  /** What ands last saw on each phone: refs, the app in front, the field last tapped. From the phone, never the model. */
  seen = new Map<string, { screen: PhoneScreen; lastTapped?: PhoneElement }>();

  constructor(o: { adb?: AdbRunner; http?: Http; iphones?: string[] } = {}) {
    this.adb = o.adb;
    this.http = o.http ?? fetchHttp;
    this.iphones = o.iphones ?? [];
  }

  async list(): Promise<PhoneInfo[]> {
    const all: PhoneInfo[] = [];
    if (this.adb) {
      const r = await this.adb(['devices', '-l'], { timeoutMs: 15_000 });
      if (r.ok) all.push(...parseAdbDevices(r.out));
    }
    for (const url of this.iphones) {
      const p = this.iphone(url);
      const ok = await this.http('GET', `${p.url}/status`).then((r) => r.status < 400).catch(() => false);
      all.push({ ...p.info, state: ok ? 'ready' : 'unreachable' });
    }
    return all;
  }

  iphone(url: string): IosPhone {
    const key = url.replace(/\/+$/, '');
    let p = this.ios.get(key);
    if (!p) this.ios.set(key, (p = new IosPhone(key, this.http)));
    return p;
  }

  /** The phone with this id, or the only ready one. */
  async get(id?: string): Promise<Phone> {
    const all = await this.list();
    const ready = all.filter((p) => p.state === 'ready');
    const pick = id ? all.find((p) => p.id === id || p.name.toLowerCase() === id.toLowerCase()) : ready.length === 1 ? ready[0] : undefined;
    if (!pick) {
      if (!all.length) throw new PhoneError('NO_PHONE', 'No phone is connected. Android: plug it in with USB debugging on (or `ands phone wifi`). iPhone: `ands phone iphone <address>`. Setup: https://ands.sh/en/phone');
      if (!id && ready.length > 1) throw new PhoneError('WHICH_PHONE', `Several phones are connected; pass phone: one of ${ready.map((p) => `${p.id} (${p.name})`).join(', ')}.`);
      const bad = all.find((p) => p.state !== 'ready');
      if (bad?.state === 'unauthorized') throw new PhoneError('PHONE_UNAUTHORIZED', 'The phone has not allowed this computer yet. Unlock it and tap Allow on "Allow USB debugging?".');
      throw new PhoneError('NO_PHONE', `No ready phone${id ? ` called ${id}` : ''}. Connected: ${all.map((p) => `${p.id} (${p.state})`).join(', ') || 'none'}.`);
    }
    if (pick.state !== 'ready') throw new PhoneError(pick.state === 'unauthorized' ? 'PHONE_UNAUTHORIZED' : 'PHONE_UNREACHABLE', pick.state === 'unauthorized' ? 'Unlock the phone and tap Allow on "Allow USB debugging?".' : `${pick.name} is ${pick.state}.`);
    return pick.platform === 'ios' ? this.iphone(pick.id) : new AndroidPhone(pick, this.adb!);
  }
}
