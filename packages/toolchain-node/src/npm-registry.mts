import type { PublicRegistry } from '@mesh-flow/core'

/**
 * The npm registry, for the sandbox's `registries`: `npm ci`, `pnpm install` and `bun install` in
 * the sandbox then restore from it through the run's package proxy. Package documents and tarballs
 * are below the package's name; `/-/` is the registry's own API (search, audit, users), which
 * restore doesn't need, so it isn't reachable. Yarn asks for `registry.yarnpkg.com` by default,
 * which this isn't.
 *
 * ```ts
 * import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
 *
 * export default defineMeshFlow({
 * 	sandbox: image({
 * 		name: 'node:26-slim',
 * 		registries: [npmRegistry],
 * 	}),
 * 	workflows: [
 * 		userTrigger(fixIssue),
 * 	],
 * })
 * ```
 */
export const npmRegistry: PublicRegistry = Object.freeze({
	name: 'npm',
	host: 'registry.npmjs.org',
	paths: Object.freeze(['/']),
	excludedPaths: Object.freeze(['/-/']),
})
