import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { duration } from '../duration/src/_module/duration.mts'

/** How long a test, or a hook, may take. */
const testTimeout = duration.of('30s')

export default defineConfig({
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first. Not through the
		// `source` condition: Pi's packages declare it too, without shipping their sources.
		alias: {
			'@mesh-flow/duration': fileURLToPath(new URL('../duration/src/_module/duration.mts', import.meta.url)),
			'@mesh-flow/protocol': fileURLToPath(new URL('../protocol/src/_module/protocol.mts', import.meta.url)),
		},
	},
	test: {
		include: ['test/**/*.{test,specification}.mts'],
		testTimeout: testTimeout.to('ms'),
		hookTimeout: testTimeout.to('ms'),
	},
})
