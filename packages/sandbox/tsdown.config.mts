import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['src/index.mts', 'src/e2b.mts', 'src/microsandbox.mts', 'src/gvisor.mts'],
	format: ['esm'],
	platform: 'node',
	dts: true,
	clean: true,
	sourcemap: true,
})
