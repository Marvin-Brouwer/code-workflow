import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packagesDirectory = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first. Not through
		// the `source` condition: Pi's packages, under the gateway, declare it too without shipping
		// their sources.
		alias: [
			{ find: /^@mesh-flow\/([\w-]+)$/, replacement: `${packagesDirectory}$1/src/_module/$1.mts` },
			{ find: /^@mesh-flow\/([\w-]+)\/([\w-]+)$/, replacement: `${packagesDirectory}$1/src/_module/$2.mts` },
		],
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
