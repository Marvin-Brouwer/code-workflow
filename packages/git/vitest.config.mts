import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { duration } from '../duration/src/_module/duration.mts'

/** How long a test, or a hook, may take. */
const testTimeout = duration.of('30s')

export default defineConfig({
	resolve: {
		// The duration package resolves to its sources, so nothing has to be built first.
		alias: { '@mesh-flow/duration': fileURLToPath(new URL('../duration/src/_module/duration.mts', import.meta.url)) },
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		testTimeout: testTimeout.to('ms'),
		hookTimeout: testTimeout.to('ms'),
	},
})
