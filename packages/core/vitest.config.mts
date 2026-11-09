import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		// The protocol resolves to its sources, so nothing has to be built first. Not through the
		// `source` condition: Pi's packages declare it too, without shipping their sources.
		alias: {
			'@mesh-flow/protocol': fileURLToPath(new URL('../protocol/src/_module/protocol.mts', import.meta.url)),
			// For tests only: the gateway on the host side of a test's channel.
			'@mesh-flow/gateway': fileURLToPath(new URL('../gateway/src/_module/gateway.mts', import.meta.url)),
		},
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
