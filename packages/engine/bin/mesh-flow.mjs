#!/usr/bin/env node
// The `mesh-flow` command. It lives outside `dist` so that pnpm links it at install time, before
// the engine is built: a fresh clone can then build the examples in the same `pnpm build`. Run
// before that build, it says so instead of printing a module resolution error.
const cliUrl = new URL('../dist/cli.mjs', import.meta.url)

try {
	await import(cliUrl.href)
} catch (error) {
	if (error?.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== cliUrl.href) throw error
	console.error('The mesh-flow engine is not built yet: run `pnpm build` first.')
	process.exitCode = 1
}
