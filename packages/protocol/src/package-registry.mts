import { z } from 'zod'
import { ConnectorName } from './connector-name.mts'

/**
 * A public package registry a run may restore packages from, through the gateway: `nuget` is
 * nuget.org's v3 feed and `npm` is the npm registry. The sandbox has no network of its own.
 */
export const PublicRegistry = z.enum(['nuget', 'npm'])
export type PublicRegistry = z.infer<typeof PublicRegistry>

/**
 * The host of each public registry, as package managers ask for it over HTTPS: the runtime's proxy
 * in the sandbox takes requests for these hosts, and the gateway sends them there.
 */
export const packageRegistryHosts: Readonly<Record<PublicRegistry, string>> = Object.freeze({
	nuget: 'api.nuget.org',
	npm: 'registry.npmjs.org',
})

/** A DNS name, in lower case, as package managers ask for it over HTTPS. */
const Hostname = z
	.string()
	.max(253)
	.regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/, 'Use a host name in lower case, such as example.com.')

/** Where a connector's registry serves packages on its host: a path that starts and ends with `/`. */
const PathPrefix = z.string().regex(/^\/(?:[\w.~-]+\/)+$/, 'Use a path that starts and ends with /, such as /npm/packages/.')

/**
 * A private registry that a connector reaches with its credential, on the host, such as a
 * CodeArtifact repository through `@mesh-flow/aws`. The proxy in the sandbox sends requests for
 * `host` below one of `paths` to it; the connector checks them again and adds the credential.
 */
export const ConnectorRegistry = z.object({
	/** The connector that fetches from it, such as `aws`. */
	connector: ConnectorName,
	/** What the user sees it as, such as `codeartifact example/packages`. */
	name: z.string().min(1).max(200),
	/** The host package managers ask for, as the repository's config names it. */
	host: Hostname,
	/** The paths on `host` that are this registry's, each ending in `/`. */
	paths: z.array(PathPrefix).min(1),
	/** What the connector needs to know which registry it is, such as a CodeArtifact domain and repository. */
	settings: z.record(z.string(), z.string()),
})
export type ConnectorRegistry = z.infer<typeof ConnectorRegistry>

/** A registry a run restores from: a public one by name, or a connector's own. */
export const PackageRegistry = z.union([PublicRegistry, ConnectorRegistry])
export type PackageRegistry = z.infer<typeof PackageRegistry>

/** A registry's name, as messages and `mesh-flow show` say it. */
export function registryName(registry: PackageRegistry): string {
	return typeof registry === 'string' ? registry : registry.name
}

/** A registry's key: the same for the same registry, however its fields are ordered. */
export function registryKey(registry: PackageRegistry): string {
	if (typeof registry === 'string') return registry
	const settings = Object.entries(registry.settings).toSorted(([one], [other]) => one.localeCompare(other))
	return JSON.stringify([registry.connector, registry.host, registry.paths.toSorted(), settings])
}

/** The host a registry's packages are asked for on. */
export function registryHost(registry: PackageRegistry): string {
	return typeof registry === 'string' ? packageRegistryHosts[registry] : registry.host
}

/** The paths on its host that are a registry's: all of them for a public one. */
export function registryPaths(registry: PackageRegistry): readonly string[] {
	return typeof registry === 'string' ? ['/'] : registry.paths
}

/** The longest path and query a fetch may have: package managers' URLs are far shorter. */
const maxPathLength = 2048

/** The longest `accept` header a fetch may send: npm's longest is about a hundred characters. */
const maxAcceptLength = 512

/**
 * A package fetch, as a package manager in the sandbox made it: the registry and the path on it,
 * with its query. Only reads: the gateway turns down anything but a fetch of a package or its
 * metadata.
 */
export const PackageRequest = z.object({
	registry: PackageRegistry,
	/** The path on the registry's host and the query, such as `/v3-flatcontainer/newtonsoft.json/index.json`. */
	path: z.string().startsWith('/').max(maxPathLength),
	/** The `accept` header the package manager sent: npm asks for abbreviated package documents with it. */
	accept: z.string().max(maxAcceptLength).optional(),
})
export type PackageRequest = z.infer<typeof PackageRequest>

/** Names a file the engine staged in the mailbox's `packages` folder: see `stagedFile`. */
export const StagedFileName = z.string().regex(/^[\w-]{1,64}\.body$/)

/**
 * What the registry answered a package fetch with. A 404 is an answer too: package managers ask
 * for what may not exist. The body isn't in the answer: the engine writes it into the sandbox as
 * a file first, so the mailbox only carries small JSON, and the runtime reads it from there.
 */
export const PackageResponse = z.object({
	status: z.int(),
	/** The headers the package manager needs, such as `content-type` and `etag`. */
	headers: z.record(z.string(), z.string()),
	/** The body's file in the mailbox's `packages` folder. The runtime removes it once it read it. */
	body: StagedFileName,
	/** The body's length, in bytes. */
	size: z.int().nonnegative(),
})
export type PackageResponse = z.infer<typeof PackageResponse>
