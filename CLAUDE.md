# ands — working rules

- This repo is public and holds only the CLI/MCP (`packages/cli`, npm `andsh`) and `@ands/core`. The website and the desktop app are private in barzaken/ands-cloud (Bar, 2026-11-01); never add them back here.

- Every new package (npm or crate) needs Bar's explicit approval before it is installed. Approved so far: typescript 6.0.3, @types/node 24.19.0, next 16.3.8, react/react-dom 19.3.0, motion 13.4.6, @next/mdx 16.3.8, @mdx-js/loader + @mdx-js/react 3.1.1, @types/react(-dom) 19.3.0, @types/mdx 2.0.14, Tauri 2 (@tauri-apps/cli, @tauri-apps/api, crates tauri, tauri-build), tauri-plugin-global-shortcut 2 (crate only, approved Oct 31 2026).
- TypeScript everywhere. `packages/*` have zero runtime dependencies; Node 22.18+ runs the .ts sources (erasable syntax only: no enums, namespaces or parameter properties; import with `.ts` extensions).
- The approval gate (`packages/core/src/gate.ts`, `policy.ts`) is the product's safety line. Never let a code path reach the engine without `Gate.check`, and never let model output lower a tier.
- `npm test` and `npm run typecheck` pass before every push.
- Bar writes in Hebrew; replies to Bar are in Hebrew.
