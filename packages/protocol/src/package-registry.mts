import { z } from 'zod'
import { ConnectorName } from './connector-name.mts'
import { stagedFileNamePattern } from './mailbox-layout.mts'

/** The longest DNS name there is. */
const maxHostnameLength = 253

/** The longest name a registry may have, for the user to see. */
const maxRegistryNameLength = 200

/** A DNS name, in lower case, as package managers ask for it over HTTPS. */
const Hostname = z
	.string()
	.max(maxHostnameLength)
	.regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/, 'Use a host name in lower case, such as example.com.')

/** Where a registry serves packages on its host: a path that starts and ends with `/`, `/` itself too. */
const PathPrefix = z.string().regex(/^\/(?:[\w.~-]+\/)*$/, 'Use a path that starts and ends with /, such as /npm/packages/.')

/** What every registry is: where package managers ask for it, and which paths on that host are package fetches. */
const registryFields = {
	/** What the user sees it as, such as `nuget.org` or `codeartifact example/packages`. */
	name: z.string().min(1).max(maxRegistryNameLength),
	/** The host package managers ask for, as their config names it. */
	host: Hostname,
	/** The paths on `host` that are this registry's package fetches, each ending in `/`. */
	paths: z.array(PathPrefix).min(1),
	/** Paths below `paths` that aren't package fetches, such as the npm registry's own API below `/-/`. */
	excludedPaths: z.array(PathPrefix).optional(),
}

/**
 * A public package registry, which the gateway fetches from without a credential, such as
 * `nugetOrg` from `@mesh-flow/toolchain-dotnet`. The package of the registry's ecosystem defines it:
 * the app lists it in the sandbox's `registries`, and only what's listed there is reachable.
 */
export const PublicRegistry = z.strictObject(registryFields)
export type PublicRegistry = z.infer<typeof PublicRegistry>

/**
 * A private registry that a connector reaches with its credential, on the host, such as a
 * CodeArtifact repository through `@mesh-flow/aws`. The proxy in the sandbox sends requests for
 * `host` below one of `paths` to it; the connector checks them again and adds the credential.
 */
export const ConnectorRegistry = z.strictObject({
	...registryFields,
	/** The connector that fetches from it, such as `aws`. */
	connector: ConnectorName,
	/** What the connector needs to know which registry it is, such as a CodeArtifact domain and repository. */
	settings: z.record(z.string(), z.string()),
})
export type ConnectorRegistry = z.infer<typeof ConnectorRegistry>

/** A registry a run restores from: a public one or a connector's own. */
export const PackageRegistry = z.union([ConnectorRegistry, PublicRegistry])
export type PackageRegistry = z.infer<typeof PackageRegistry>

/** Whether `registry` is a connector's own, which the connector fetches from with its credential. */
export function isConnectorRegistry(registry: PackageRegistry): registry is ConnectorRegistry {
	return 'connector' in registry
}

/**
 * A registry's key: the same for the same registry, however its fields are ordered. Every field
 * that says what it reaches is in it, so a registry with other paths is another registry.
 */
export function registryKey(registry: PackageRegistry): string {
	const settings = isConnectorRegistry(registry)
		? Object.entries(registry.settings).toSorted(([one], [other]) => one.localeCompare(other))
		: []
	return JSON.stringify([
		isConnectorRegistry(registry) ? registry.connector : null,
		registry.host,
		registry.paths.toSorted(),
		(registry.excludedPaths ?? []).toSorted(),
		settings,
	])
}

/** `registries` with each registry once, by {@link registryKey}, in the order they first come. */
export function uniqueRegistries<Registry extends PackageRegistry>(registries: readonly Registry[]): Registry[] {
	return [...new Map(registries.map((registry) => [registryKey(registry), registry])).values()]
}

/**
 * The length of the longest of the registry's paths that `pathname` is below, or `undefined` when
 * it isn't a package fetch on the registry: below none of its paths, or below an excluded one. A
 * path itself, such as `/` of the npm registry, isn't below it.
 */
export function servedPrefixLength(registry: PackageRegistry, pathname: string): number | undefined {
	const isBelow = (prefix: string) => pathname.length > prefix.length && pathname.startsWith(prefix)
	if ((registry.excludedPaths ?? []).some(isBelow) || (registry.excludedPaths ?? []).includes(pathname)) return undefined
	const lengths = registry.paths.filter(isBelow).map((prefix) => prefix.length)
	return lengths.length === 0 ? undefined : Math.max(...lengths)
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

/** Names a file the engine staged in the mailbox's `staged` folder: see `stagedFile`. */
export const StagedFileName = z.string().regex(stagedFileNamePattern)

/**
 * What the registry answered a package fetch with. A 404 is an answer too: package managers ask
 * for what may not exist. The body isn't in the answer: the engine writes it into the sandbox as
 * a file first, so the mailbox only carries small JSON, and the runtime reads it from there.
 */
export const PackageResponse = z.object({
	status: z.int(),
	/** The headers the package manager needs, such as `content-type` and `etag`. */
	headers: z.record(z.string(), z.string()),
	/** The body's file in the mailbox's `staged` folder. The runtime removes it once it read it. */
	body: StagedFileName,
	/** The body's length, in bytes. */
	size: z.int().nonnegative(),
})
export type PackageResponse = z.infer<typeof PackageResponse>
