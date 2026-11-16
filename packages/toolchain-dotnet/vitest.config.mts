import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first. Not through the
		// `source` condition: Pi's packages declare it too, without shipping their sources.
		alias: {
			'@mesh-flow/protocol': source('../protocol/src/_module/protocol.mts'),
			'@mesh-flow/core': source('../core/src/_module/core.mts'),
		},
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		unstubEnvs: true,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
