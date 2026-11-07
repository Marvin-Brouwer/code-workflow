import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		// gVisor is Linux only, and its unit tests run POSIX shell scripts.
		exclude: [...configDefaults.exclude, ...(process.platform === 'win32' ? ['test/gvisor/**', 'test/conformance/gvisor.spec.mts'] : [])],
		// The conformance suite starts real sandboxes; a pause writes all memory to disk first.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
})
