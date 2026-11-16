import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first. Not through the
		// `source` condition: Pi's packages declare it too, without shipping their sources.
		alias: {
			'@mesh-flow/protocol': source('../protocol/src/_module/protocol.mts'),
			'@mesh-flow/gateway': source('../gateway/src/_module/gateway.mts'),
			'@mesh-flow/core': source('../core/src/_module/core.mts'),
			'@mesh-flow/git': source('../git/src/_module/git.mts'),
			'@mesh-flow/code-repository/host': source('../code-repository/src/_module/host.mts'),
			'@mesh-flow/code-repository': source('../code-repository/src/_module/code-repository.mts'),
		},
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
