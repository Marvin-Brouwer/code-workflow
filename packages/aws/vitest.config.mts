import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first: protocol too,
		// which gateway's sources import.
		alias: {
			'@mesh-flow/protocol': source('../protocol/src/_module/protocol.mts'),
			'@mesh-flow/gateway': source('../gateway/src/_module/gateway.mts'),
		},
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
