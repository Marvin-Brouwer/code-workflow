import { defineConfig } from 'vitest/config'

export default defineConfig({
	// Workspace packages resolve to their sources, so nothing has to be built first.
	ssr: { resolve: { conditions: ['source', 'node', 'import', 'module', 'default'] } },
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
