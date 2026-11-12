#!/usr/bin/env node
// The `mesh-flow` command in this workspace. It lives outside `dist` so that pnpm links it at
// install time, before the engine is built: a fresh clone can then build the examples in the same
// `pnpm build`. Node runs it by stripping its types. Run before that build, it says so instead of
// printing a module resolution error. The published package points its bin at `dist/cli.mjs`.
const cliUrl = new URL('../dist/cli.mjs', import.meta.url)

function isCliMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND' && 'url' in error && error.url === cliUrl.href
}

try {
	await import(cliUrl.href)
} catch (error) {
	if (!isCliMissing(error)) throw error
	console.error('The mesh-flow engine is not built yet: run `pnpm build` first.')
	process.exitCode = 1
}
