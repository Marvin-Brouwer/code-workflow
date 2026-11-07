import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['test/**/*.{test,spec}.mts'],
		// gVisor only runs on Linux, and its tests drive a shell script that stands in for runsc.
		exclude: process.platform === 'win32' ? ['test/gvisor/**', 'test/conformance/gvisor.spec.mts'] : [],
		// The conformance suite starts real sandboxes; a pause writes all memory to disk first.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
})
