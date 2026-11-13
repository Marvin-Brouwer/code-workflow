import { defineConfig } from 'tsdown'

// Every file in `src/_module` is one public entry point, named after the file.
export default defineConfig({
	entry: ['src/_module/*.mts'],
	format: ['esm'],
	platform: 'node',
	treeshake: { moduleSideEffects: 'no-external' },
	dts: true,
	clean: true,
	sourcemap: true,
})
