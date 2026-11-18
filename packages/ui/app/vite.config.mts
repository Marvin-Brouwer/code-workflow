import { cssLoader } from '@rooted/components/css-loader'
import { generateRouteManifest } from '@rooted/router/manifest'
import { defaultClientConditions, defineConfig } from 'vite'

/**
 * A plain Vite config with rooted's CSS loader and route discovery. Not `rootedManifest` from
 * `@rooted/application`: its PWA, SEO and pre-rendering are for public sites, and this page is
 * served on the engine's machine only.
 */
export default defineConfig({
	appType: 'spa',
	resolve: {
		// Workspace packages resolve to their sources, so nothing has to be built first.
		conditions: ['source', ...defaultClientConditions],
	},
	plugins: [
		generateRouteManifest({
			glob: './src/**/_routes.mts',
			routeManifestPath: './src/_routes.g.mts',
		}),
		cssLoader(),
	],
	build: {
		target: 'esnext',
		// Next to the package's server, which serves it.
		outDir: '../dist/app',
		emptyOutDir: true,
	},
})
