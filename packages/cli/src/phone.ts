// `ands phone`: connect the person's own phone, and see what ands sees on it.
import { ensureAdb, runAdb, nodePhones, loadConfig, saveConfig, phoneLines, PhoneError } from '@ands/core';

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

export const PHONE_HELP = `ands phone: your own phone, as hands (Android over USB or Wi-Fi, iPhone over Wi-Fi)

  ands phone                         list connected phones
  ands phone wifi IP:PORT [CODE]     Android over Wi-Fi: Developer options > Wireless debugging.
                                     First time: "Pair device with pairing code" gives IP:PORT and CODE.
  ands phone iphone URL              add an iPhone running WebDriverAgent, e.g. http://192.168.1.20:8100
  ands phone iphone --remove URL
  ands phone look [--phone ID]       what ands sees on the phone right now
  ands phone setup                   get Android's adb now (otherwise on first use)

  Setup guide: https://ands.sh/en/phone
`;

export async function phone(args: string[]) {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case undefined: case 'list': {
        const all = await nodePhones().list();
        if (!all.length) return out('No phone connected.\n\n' + PHONE_HELP);
        for (const p of all) out(`${p.state === 'ready' ? '●' : '○'} ${p.platform === 'ios' ? 'iPhone ' : 'Android'} ${p.name.padEnd(20)} ${p.id}  ${p.state === 'unauthorized' ? 'unlock the phone and tap Allow' : p.state}`);
        return;
      }
      case 'help': case '--help': return out(PHONE_HELP);
      case 'setup': return out(`✓ adb: ${await ensureAdb()}`);
      case 'wifi': {
        const [addr, code] = rest;
        if (!addr || !/^[\w.-]+:\d+$/.test(addr)) { err('Usage: ands phone wifi IP:PORT [CODE]'); process.exitCode = 1; return; }
        if (code) {
          const p = await runAdb(['pair', addr, code], { timeoutMs: 30_000 });
          out(p.ok ? p.out.trim() : `✗ ${p.message}`);
          if (!p.ok) { process.exitCode = 1; return; }
          out('Paired. Now run `ands phone wifi IP:PORT` with the address shown under "Wireless debugging" (not the pairing one).');
          return;
        }
        const c = await runAdb(['connect', addr], { timeoutMs: 20_000 });
        out(c.ok && !/failed|unable|refused/i.test(c.out) ? `✓ ${c.out.trim()}` : `✗ ${(c.message ?? c.out).trim()}`);
        return;
      }
      case 'iphone': {
        const remove = rest[0] === '--remove';
        const url = (remove ? rest[1] : rest[0])?.replace(/\/+$/, '');
        if (!url || !/^https?:\/\/[\w.:[\]-]+$/.test(url)) { err('Usage: ands phone iphone http://IP:8100'); process.exitCode = 1; return; }
        const now = loadConfig().iphones ?? [];
        saveConfig({ iphones: remove ? now.filter((u) => u !== url) : [...new Set([...now, url])] });
        if (remove) return out(`Removed ${url}`);
        const ready = (await nodePhones().list()).find((p) => p.id === url)?.state === 'ready';
        return out(ready ? `✓ iPhone at ${url} is ready.` : `Saved ${url}, but it does not answer yet. Is WebDriverAgent running on the iPhone, on the same Wi-Fi? Guide: https://ands.sh/en/phone`);
      }
      case 'look': {
        const i = rest.indexOf('--phone');
        const p = await nodePhones().get(i >= 0 ? rest[i + 1] : undefined);
        return out(phoneLines(await p.screen()));
      }
      default: err(`Unknown: ands phone ${sub}\n`); process.exitCode = 1; return out(PHONE_HELP);
    }
  } catch (e: any) {
    err(e instanceof PhoneError ? `✗ ${e.message}` : `✗ ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
