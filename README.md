# ands

Hands for AI agents. ands operates the apps on your computer (click, type, open, send) through the operating system's accessibility tree, and your own phone too (Android and iPhone), and waits for your approval before anything that matters.

| Part | Path | What it is |
|---|---|---|
| Core | `packages/core` | Approval gate, tools, engine wrapper, remote link |
| CLI + MCP | `packages/cli` | The `andsh` npm package (the name `ands` belongs to someone else): `ands mcp` and `ands link` |
| Desktop app | [ands.sh/download](https://ands.sh/download) | ands for everyone (mac, Windows, Linux) |
| Engine | [agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0, by Vercel Labs; used unmodified) | Rust CLI that reads and operates desktop apps |

## Try it

```sh
claude mcp add ands -- npx -y andsh mcp     # Claude Code
npx andsh mcp --config cursor               # config for Cursor, Claude Desktop, VS Code, Codex
npx andsh link                              # connect a cloud agent by URL
```

From a checkout:

```sh
npm install
claude mcp add ands -- node /abs/path/to/packages/cli/bin/ands.mjs mcp
npm run ands -- mcp --config cursor         # config for Cursor, Claude Desktop, VS Code, Codex
```

## Several jobs at once

ands works in the background, through accessibility, so you can keep using the computer. Every tool
takes an optional `agent` name: give each independent job its own name (one per subagent, say) and they
run in parallel, each with its own cursor on the screen. Steps that depend on each other ("download the
PDFs, then file them, then send them") stay under one name. A step with no background path (a key press,
or typing on Windows) briefly uses the real keyboard, one agent at a time.

## Your phone too

The same agent can work on your own phone, connected to this computer: no cloud phone, nothing installed
from a store, no account. The phone tools (`ands_phones`, `ands_phone_look`, `ands_phone_tap`,
`ands_phone_type`, `ands_phone_swipe`, `ands_phone_button`, `ands_phone_apps`, `ands_phone_screenshot`) go
through the same approvals: a tap on Send, Pay or Delete, Enter in a message, a spot ands has not seen, and a
picture of the screen always ask.

- **Android**: turn on Developer options > USB debugging, plug the phone in and tap Allow. Over Wi-Fi:
  `ands phone wifi IP:PORT CODE` once (Wireless debugging > Pair with code), then `ands phone wifi IP:PORT`.
  ands uses the adb you have, or fetches Google's platform-tools once into `~/.ands` (checked against the
  SHA-1 in Google's SDK index; [Android SDK License](https://developer.android.com/studio/terms)). Typing over
  adb is English letters, digits and symbols only.
- **iPhone**: install [WebDriverAgent](https://github.com/appium/WebDriverAgent) (BSD-3, by Appium) on the
  phone once from a Mac with Xcode, start it, then `ands phone iphone http://<phone IP>:8100`. Typing works in
  any language. A free Apple ID signs it for 7 days; a developer account for a year.

```sh
npx andsh phone                 # phones ands can reach
npx andsh phone look            # what ands sees on the phone
```

## Approvals

Every action is sorted before it runs, outside the model:

- **read** (look at a window, list apps): goes through
- **change** (click, type, open, Enter in a search box): goes through, or asked one by one with `ands trust ask_all`
- **sensitive** (send, pay, delete, install, sign in, Enter elsewhere, reading the clipboard, screenshots, a tap or click on a spot ands has not seen): always asks

MCP clients that support elicitation get the question inside the client; otherwise the OS dialog asks. Every action is logged to `~/.ands/history.jsonl` (`ands history`).

## Rules

- Everything is TypeScript. Node 22.18+ runs the sources directly.
- Every new package is approved by Bar before it is installed.
- `npm test` and `npm run typecheck` pass before every push.

## License

ands is licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE). It ships the
agent-desktop engine unmodified, plus the open-source parts listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Regenerate that file after a dependency or engine
update with `node scripts/third-party-notices.mjs --engine <agent-desktop checkout> --desktop <app src-tauri>`. ands is an
independent project, not affiliated with or endorsed by Vercel or any product named on the site.
