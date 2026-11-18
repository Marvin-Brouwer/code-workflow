import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { duration } from '../duration/src/_module/duration.mts'

export default defineConfig({
	resolve: {
		// The duration package resolves to its sources, so nothing has to be built first.
		alias: { '@mesh-flow/duration': fileURLToPath(new URL('../duration/src/_module/duration.mts', import.meta.url)) },
	},
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		// gVisor is Linux only, and its unit tests run POSIX shell scripts.
		exclude: [...configDefaults.exclude, ...(process.platform === 'win32' ? ['test/gvisor/**', 'test/conformance/gvisor.spec.mts'] : [])],
		// The conformance suite starts real sandboxes; a pause writes all memory to disk first.
		testTimeout: duration.of('2m').to('ms'),
		hookTimeout: duration.of('2m').to('ms'),
	},
})
