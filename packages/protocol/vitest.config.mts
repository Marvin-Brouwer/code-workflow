import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		// The duration package resolves to its sources, so nothing has to be built first.
		alias: { '@mesh-flow/duration': fileURLToPath(new URL('../duration/src/_module/duration.mts', import.meta.url)) },
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
	},
})
