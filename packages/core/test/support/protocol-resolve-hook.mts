import { pathToFileURL } from 'node:url'

const protocol = pathToFileURL(new URL('../../../protocol/src/_module/protocol.mts', import.meta.url).pathname).href

interface ResolveContext {
	readonly conditions: readonly string[]
}
type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string }>

/** Resolves `@mesh-flow/protocol` to its sources; everything else as usual. */
export async function resolve(specifier: string, context: ResolveContext, next: NextResolve): Promise<{ url: string }> {
	return next(specifier === '@mesh-flow/protocol' ? protocol : specifier, context)
}
