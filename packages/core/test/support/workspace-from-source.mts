import { registerHooks } from 'node:module'

/**
 * Loaded with `node --import` by the tests that start an entry file in a process of its own: lets
 * the `@mesh-flow/*` packages resolve to their sources, through their `source` condition, so the
 * test runs without building them. Pi's packages declare a `source` condition without shipping
 * their sources, so `--conditions=source` can't do this.
 */
registerHooks({
	resolve: (specifier, context, nextResolve) =>
		specifier.startsWith('@mesh-flow/')
			? nextResolve(specifier, { ...context, conditions: ['source', ...context.conditions] })
			: nextResolve(specifier, context),
})
