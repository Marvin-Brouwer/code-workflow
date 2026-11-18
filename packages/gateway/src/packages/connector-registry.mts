import type { ConnectorRegistry } from '@mesh-flow/protocol'

/** A package fetch on a connector's registry, as the proxy in the sandbox took it. */
export interface ConnectorRegistryRequest {
	readonly registry: ConnectorRegistry
	/** The path on the registry's host and the query. */
	readonly path: string
	/** The `accept` header the package manager sent. */
	readonly accept?: string
}

/** Where a fetch on a connector's registry goes, with the credential the connector adds. */
export interface RegistryTarget {
	/** The URL to fetch, on the registry's host. */
	readonly url: string
	/** The headers to send it with, such as `authorization`. Only sent to the registry's own host, not after a redirect. */
	readonly headers: Readonly<Record<string, string>>
}

/**
 * How a connector reaches its registries: it checks that the fetch is a read on a registry it
 * serves and says where it goes, with the credential. The gateway sends it, caps the body, caches
 * packages and stages the body for the sandbox. Throw a `SignInNeededError` when the user has to sign
 * in first, and an error when the fetch isn't a read on the registry.
 *
 * ```ts
 * const resolve: ResolveRegistryTarget = async ({ registry, path }, abortSignal) => {
 * 	const isOnRegistry = registry.paths.some((prefix) => path.startsWith(prefix))
 * 	if (!isOnRegistry) throw new Error(`${path} isn't on ${registry.name}.`)
 *
 * 	return {
 * 		url: `https://${registry.host}${path}`,
 * 		headers: { authorization: `Bearer ${await token(abortSignal)}` },
 * 	}
 * }
 * ```
 */
export type ResolveRegistryTarget = (request: ConnectorRegistryRequest, abortSignal: AbortSignal) => Promise<RegistryTarget>
