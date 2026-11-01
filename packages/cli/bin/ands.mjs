#!/usr/bin/env node
// Runs the TypeScript sources directly (Node 22.18+ strips types). The published package ships built JS instead.
import { main } from '../src/main.ts';
main().catch((e) => { process.stderr.write(`ands: ${e?.message ?? e}\n`); process.exitCode = 1; });
