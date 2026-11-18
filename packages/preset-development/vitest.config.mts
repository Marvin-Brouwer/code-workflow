import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { duration } from '../duration/src/_module/duration.mts'

const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

/** How long a test, or a hook, may take. */
const testTimeout = duration.of('30s')

export default defineConfig({
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first. Not through the
		// `source` condition: Pi's packages declare it too, without shipping their sources.
		alias: {
			'@mesh-flow/duration': source('../duration/src/_module/duration.mts'),
			'@mesh-flow/protocol': source('../protocol/src/_module/protocol.mts'),
			'@mesh-flow/core': source('../core/src/_module/core.mts'),
			'@mesh-flow/git': source('../git/src/_module/git.mts'),
		},
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		unstubEnvs: true,
		testTimeout: testTimeout.to('ms'),
		hookTimeout: testTimeout.to('ms'),
	},
})
