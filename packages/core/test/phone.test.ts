import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, Gate, Phones, runPhoneTool, parseUiautomator, parseAdbDevices, parseWdaSource, adbText, phoneLines, platformToolsArchive, type Ask, type AdbRunner, type Http } from '../src/index.ts';

process.env.ANDS_HOME = `${process.env.TMPDIR ?? '/tmp'}/ands-phone-test-${process.pid}`;

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" clickable="false" bounds="[0,0][1080,80]" />
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.whatsapp" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
<node index="1" text="Mom &amp; Dad" resource-id="com.whatsapp:id/conversation_contact_name" class="android.widget.TextView" package="com.whatsapp" content-desc="" clickable="true" bounds="[150,90][700,170]" />
<node index="2" text="" resource-id="com.whatsapp:id/entry" class="android.widget.EditText" package="com.whatsapp" content-desc="" clickable="true" focused="true" bounds="[40,2200][900,2320]" />
<node index="3" text="" resource-id="com.whatsapp:id/send" class="android.widget.ImageButton" package="com.whatsapp" content-desc="Send" clickable="true" bounds="[920,2200][1060,2320]" />
<node index="4" text="" resource-id="" class="android.view.View" package="com.whatsapp" content-desc="" clickable="false" bounds="[0,300][1080,2100]" />
</node></hierarchy>`;

const fakeAdb = (o: { app?: string; xml?: string; seen?: string[][] } = {}): AdbRunner => async (args) => {
  o.seen?.push(args);
  const cmd = args.join(' ');
  if (cmd === 'devices -l') return { ok: true, out: 'List of devices attached\nR5CT123 device usb:1-1 product:x model:Pixel_7 device:panther\n\n' };
  if (cmd.includes('uiautomator dump')) return { ok: true, out: o.xml ?? XML };
  if (cmd.includes('wm size')) return { ok: true, out: 'Physical size: 1080x2400\n' };
  if (cmd.includes('dumpsys window')) return { ok: true, out: `  mCurrentFocus=Window{1 u0 ${o.app ?? 'com.whatsapp'}/com.whatsapp.Conversation}\n` };
  if (cmd.includes('pm list packages')) return { ok: true, out: 'package:com.whatsapp\npackage:com.waze\npackage:com.android.chrome\n' };
  return { ok: true, out: '' };
};
const recorder = (answer: 'yes' | 'no' = 'yes') => {
  const asked: Ask[] = [];
  return { asked, approver: async (a: Ask) => (asked.push(a), answer) };
};

test('the screen from uiautomator: names, fields, the app in front, centers', () => {
  const s = parseUiautomator(XML);
  assert.equal(s.app, 'com.whatsapp');
  assert.deepEqual(s.elements.map((e) => [e.ref, e.role, e.name]), [['p1', 'button', 'Mom & Dad'], ['p2', 'textfield', 'entry'], ['p3', 'button', 'Send']]);
  const lines = phoneLines({ ...s, width: 1080, height: 2400 });
  assert.match(lines, /^phone app: com.whatsapp, screen 1080x2400/);
  assert.match(lines, /button "Send" p3 \[tappable\] @990,2260/);
  assert.deepEqual(parseAdbDevices('List of devices attached\nabc unauthorized usb:1\n192.168.1.5:5555 device product:p model:SM_S918B\n').map((p) => [p.id, p.name, p.state]), [['abc', 'abc', 'unauthorized'], ['192.168.1.5:5555', 'SM S918B', 'ready']]);
});

test('phone steps are sorted like the computer: send taps, unknown spots, Enter and pictures ask', () => {
  assert.equal(classify({ verb: 'phone_look' }), 'read');
  assert.equal(classify({ verb: 'phone_tap', target: { role: 'button', name: 'Send' } }), 'sensitive');
  assert.equal(classify({ verb: 'phone_tap', target: { role: 'button', name: 'שלח' } }), 'sensitive');
  assert.equal(classify({ verb: 'phone_tap', target: { role: 'button', name: 'Chats' } }), 'change');
  assert.equal(classify({ verb: 'phone_tap' }), 'sensitive');
  assert.equal(classify({ verb: 'phone_enter', target: { role: 'textfield', name: 'entry' } }), 'sensitive');
  assert.equal(classify({ verb: 'phone_enter', target: { role: 'searchfield', name: 'Search' } }), 'change');
  assert.equal(classify({ verb: 'phone_type', target: { role: 'securetextfield', name: 'Password' } }), 'sensitive');
  assert.equal(classify({ verb: 'phone_swipe' }), 'change');
  assert.equal(classify({ verb: 'phone_screenshot' }), 'sensitive');
});

test('look, then a tap on Send asks the person, an ordinary tap does not, and a no stops it', async () => {
  const seen: string[][] = [];
  const phones = new Phones({ adb: fakeAdb({ seen }) });
  const r = recorder('no');
  const gate = new Gate({ approver: r.approver });
  const ctx = { phones, gate, source: 'test' };
  const look = await runPhoneTool('ands_phone_look', {}, ctx);
  assert.equal(look.ok, true);
  assert.match(look.text, /"Send" p3/);

  const chat = await runPhoneTool('ands_phone_tap', { ref: 'p1', why: 'open' }, ctx);
  assert.equal(chat.ok, true);
  assert.equal(r.asked.length, 0);
  assert.ok(seen.some((a) => a.join(' ') === '-s R5CT123 shell input tap 425 130'));

  const send = await runPhoneTool('ands_phone_tap', { ref: 'p3', why: 'send it' }, ctx);
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].tier, 'sensitive');
  assert.equal(r.asked[0].action.target?.name, 'Send');
  assert.equal(send.ok, false);
  assert.ok(!seen.some((a) => a.join(' ').includes('input tap 990 2260')));

  // A point is judged by what is under it on the phone's screen, not by the model's words.
  await runPhoneTool('ands_phone_tap', { x: 990, y: 2260, why: 'just a button' }, ctx);
  assert.equal(r.asked.length, 2);
  assert.equal(r.asked[1].action.target?.name, 'Send');
  // A spot ands has not seen asks too.
  await runPhoneTool('ands_phone_tap', { x: 5, y: 2390, why: 'tap' }, ctx);
  assert.equal(r.asked.length, 3);
  assert.equal(r.asked[2].tier, 'sensitive');
});

test('typing then Enter in a message field asks before Enter; text is escaped for the phone', async () => {
  const seen: string[][] = [];
  const r = recorder('no');
  const ctx = { phones: new Phones({ adb: fakeAdb({ seen }) }), gate: new Gate({ approver: r.approver }), source: 'test' };
  await runPhoneTool('ands_phone_look', {}, ctx);
  await runPhoneTool('ands_phone_tap', { ref: 'p2', why: 'the field' }, ctx);
  const t = await runPhoneTool('ands_phone_type', { text: "I'm late (5 min)", submit: true, why: 'reply' }, ctx);
  assert.ok(seen.some((a) => a.join(' ') === "-s R5CT123 shell input text I\\'m%slate%s\\(5%smin\\)"));
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].action.verb, 'phone_enter');
  assert.equal(t.ok, false);
  assert.ok(!seen.some((a) => a.join(' ').includes('keyevent 66')));
  assert.throws(() => adbText('שלום'), /English letters/);
});

test('a do-not-touch app on the phone is refused, checked against the app the phone has in front', async () => {
  const r = recorder('yes');
  const ctx = { phones: new Phones({ adb: fakeAdb({ app: 'com.x8bit.bitwarden' }) }), gate: new Gate({ approver: r.approver, trust: 'autopilot' }), source: 'test' };
  const look = await runPhoneTool('ands_phone_look', {}, { ...ctx, phones: new Phones({ adb: fakeAdb({ xml: XML.replace(/com\.whatsapp/g, 'com.x8bit.bitwarden') }) }) });
  assert.equal(look.ok, false);
  assert.match(look.text, /do-not-touch/);
  const swipe = await runPhoneTool('ands_phone_swipe', { direction: 'up', why: 'scroll' }, ctx);
  assert.equal(swipe.ok, false);
  assert.match(swipe.text, /do-not-touch/);
  const open = await runPhoneTool('ands_phone_apps', { action: 'open', app: 'com.onepassword.android', why: 'x' }, ctx);
  assert.equal(open.ok, false);
});

test('an approval that must come from elsewhere is not swallowed', async () => {
  class NeedsOk extends Error {}
  const ctx = { phones: new Phones({ adb: fakeAdb() }), gate: new Gate({ approver: async () => { throw new NeedsOk('link'); } }), source: 'test' };
  await runPhoneTool('ands_phone_look', {}, ctx);
  await assert.rejects(runPhoneTool('ands_phone_tap', { ref: 'p3', why: 'send' }, ctx), NeedsOk);
});

test('opening an app by name finds its id', async () => {
  const seen: string[][] = [];
  const ctx = { phones: new Phones({ adb: fakeAdb({ seen }) }), gate: new Gate({ approver: async () => 'yes' }), source: 'test' };
  const r = await runPhoneTool('ands_phone_apps', { action: 'open', app: 'Waze', why: 'drive' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(seen.some((a) => a.join(' ') === '-s R5CT123 shell monkey -p com.waze -c android.intent.category.LAUNCHER 1'));
});

test('an iPhone through WebDriverAgent: screen, a tap as one finger, typing any language', async () => {
  const calls: [string, string, any][] = [];
  const http: Http = async (method, url, body) => {
    calls.push([method, url.replace('http://10.0.0.7:8100', ''), body]);
    const path = url.replace('http://10.0.0.7:8100', '');
    if (path === '/status') return { status: 200, json: { value: { ready: true } } };
    if (path === '/session') return { status: 200, json: { value: { sessionId: 'S1' } } };
    if (path === '/source?format=json') return { status: 200, json: { value: { type: 'XCUIElementTypeApplication', rect: { x: 0, y: 0, width: 390, height: 844 }, children: [
      { type: 'XCUIElementTypeButton', label: 'Send', rect: { x: 330, y: 780, width: 44, height: 44 }, isEnabled: true },
      { type: 'XCUIElementTypeTextView', label: '', value: '', rect: { x: 20, y: 780, width: 300, height: 44 }, isEnabled: true },
    ] } } };
    if (path === '/wda/activeAppInfo') return { status: 200, json: { value: { bundleId: 'net.whatsapp.WhatsApp' } } };
    if (path === '/session/S1/window/size') return { status: 200, json: { value: { width: 390, height: 844 } } };
    return { status: 200, json: { value: null } };
  };
  const r = recorder('yes');
  const ctx = { phones: new Phones({ http, iphones: ['http://10.0.0.7:8100'] }), gate: new Gate({ approver: r.approver }), source: 'test' };
  const look = await runPhoneTool('ands_phone_look', {}, ctx);
  assert.match(look.text, /phone app: net.whatsapp.WhatsApp/);
  assert.match(look.text, /button "Send" p1 @352,802/);
  await runPhoneTool('ands_phone_tap', { ref: 'p2', why: 'field' }, ctx);
  const tap = calls.find((c) => c[1] === '/session/S1/actions');
  assert.equal(tap?.[2].actions[0].actions[0].x, 170);
  await runPhoneTool('ands_phone_type', { text: 'מגיע בעוד 5', why: 'reply' }, ctx);
  assert.deepEqual(calls.find((c) => c[1] === '/session/S1/wda/keys')?.[2], { value: [...'מגיע בעוד 5'] });
  await runPhoneTool('ands_phone_tap', { ref: 'p1', why: 'send' }, ctx);
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].tier, 'sensitive');
  const back = await runPhoneTool('ands_phone_button', { button: 'back', why: 'back' }, ctx);
  assert.match(back.text, /no Back button/);
  assert.equal(parseWdaSource({ type: 'XCUIElementTypeOther', rect: { x: 0, y: 0, width: 0, height: 0 } }).elements.length, 0);
});

test("Google's SDK index gives this computer's platform-tools zip and its SHA-1", () => {
  const xml = `<sdk:sdk-repository><remotePackage path="build-tools;35.0.0"><archives><archive><complete><checksum>${'1'.repeat(40)}</checksum><url>bt.zip</url></complete></archive></archives></remotePackage>
<remotePackage path="platform-tools"><revision><major>36</major></revision><archives>
<archive><complete><size>1</size><checksum type="sha1">${'a'.repeat(40)}</checksum><url>platform-tools_r36.0.0-darwin.zip</url></complete><host-os>macosx</host-os></archive>
<archive><complete><size>1</size><checksum type="sha1">${'b'.repeat(40)}</checksum><url>platform-tools_r36.0.0-win.zip</url></complete><host-os>windows</host-os></archive>
</archives></remotePackage></sdk:sdk-repository>`;
  assert.deepEqual(platformToolsArchive(xml, 'win32'), { url: 'https://dl.google.com/android/repository/platform-tools_r36.0.0-win.zip', sha1: 'b'.repeat(40) });
  assert.equal(platformToolsArchive(xml, 'darwin')?.sha1, 'a'.repeat(40));
  assert.equal(platformToolsArchive(xml, 'linux'), undefined);
});
