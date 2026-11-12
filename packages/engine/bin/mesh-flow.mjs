#!/usr/bin/env node
// The `mesh-flow` command. It lives outside `dist` so that pnpm links it at install time, before
// the engine is built: a fresh clone can then build the examples in the same `pnpm build`.
const cli = new URL('../dist/cli.mjs', import.meta.url)

try {
	await import(cli.href)
} catch (error) {
	if (error?.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== cli.href) throw error
	console.error('The mesh-flow engine is not built yet: run `pnpm build` first.')
	process.exitCode = 1
}
