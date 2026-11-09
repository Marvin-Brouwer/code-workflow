interface ResolveContext {
	readonly conditions: readonly string[]
}
type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string }>

/** Resolves `@mesh-flow/*` packages through their `source` condition, to their sources; everything else as usual. */
export async function resolve(specifier: string, context: ResolveContext, next: NextResolve): Promise<{ url: string }> {
	if (!specifier.startsWith('@mesh-flow/')) return next(specifier, context)
	return next(specifier, { ...context, conditions: ['source', ...context.conditions] })
}
