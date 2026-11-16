import { registerHooks } from 'node:module'

const protocol = new URL('../../../protocol/src/_module/protocol.mts', import.meta.url).href

/**
 * Loaded with `node --import` by the engine start test: lets `@mesh-flow/protocol` resolve to its
 * sources, so the test runs without building it. Pi's packages declare a `source` condition without
 * shipping their sources, so `--conditions=source` can't do this.
 */
registerHooks({
	resolve: (specifier, context, nextResolve) => nextResolve(specifier === '@mesh-flow/protocol' ? protocol : specifier, context),
})
