import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { duration } from '../duration/src/_module/duration.mts'

/** How long a test, or a hook, may take. */
const testTimeout = duration.of('2m')

export default defineConfig({
	resolve: {
		// The duration package resolves to its sources, so nothing has to be built first.
		alias: { '@mesh-flow/duration': fileURLToPath(new URL('../duration/src/_module/duration.mts', import.meta.url)) },
	},
	test: {
		include: ['test/**/*.{test,specification}.mts'],
		// gVisor is Linux only, and its unit tests run POSIX shell scripts.
		exclude: [...configDefaults.exclude, ...(process.platform === 'win32' ? ['test/gvisor/**', 'test/conformance/gvisor.spec.mts'] : [])],
		// The conformance suite starts real sandboxes; a pause writes all memory to disk first.
		testTimeout: testTimeout.to('ms'),
		hookTimeout: testTimeout.to('ms'),
	},
})
