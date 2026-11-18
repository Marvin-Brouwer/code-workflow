import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { duration } from '../duration/src/_module/duration.mts'

const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first: protocol too,
		// which gateway's sources import.
		alias: {
			'@mesh-flow/duration': source('../duration/src/_module/duration.mts'),
			'@mesh-flow/protocol': source('../protocol/src/_module/protocol.mts'),
			'@mesh-flow/gateway': source('../gateway/src/_module/gateway.mts'),
			'@mesh-flow/core': source('../core/src/_module/core.mts'),
		},
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		testTimeout: duration.of('30s').to('ms'),
		hookTimeout: duration.of('30s').to('ms'),
	},
})
