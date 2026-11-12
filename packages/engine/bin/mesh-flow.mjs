#!/usr/bin/env node
// The `mesh-flow` command. It lives outside `dist` so that pnpm links it at install time, before
// the engine is built: a fresh clone can then build the examples in the same `pnpm build`.
await import('../dist/cli.mjs')
