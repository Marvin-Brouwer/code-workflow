import { z } from 'zod'

/**
 * A public package registry a run may restore packages from, through the gateway: `nuget` is
 * nuget.org's v3 feed and `npm` is the npm registry. The sandbox has no network of its own.
 */
export const PackageRegistry = z.enum(['nuget', 'npm'])
export type PackageRegistry = z.infer<typeof PackageRegistry>

/**
 * The host of each registry, as package managers ask for it over HTTPS: the runtime's proxy in the
 * sandbox takes requests for these hosts, and the gateway sends them there.
 */
export const packageRegistryHosts: Readonly<Record<PackageRegistry, string>> = Object.freeze({
	nuget: 'api.nuget.org',
	npm: 'registry.npmjs.org',
})

/**
 * A package fetch, as a package manager in the sandbox made it: the registry and the path on it,
 * with its query. Only reads: the gateway turns down anything but a fetch of a package or its
 * metadata.
 */
export const PackageRequest = z.object({
	registry: PackageRegistry,
	/** The path on the registry's host and the query, such as `/v3-flatcontainer/newtonsoft.json/index.json`. */
	path: z.string().startsWith('/').max(2048),
	/** The `accept` header the package manager sent: npm asks for abbreviated package documents with it. */
	accept: z.string().max(512).optional(),
})
export type PackageRequest = z.infer<typeof PackageRequest>

/** What the registry answered a package fetch with. A 404 is an answer too: package managers ask for what may not exist. */
export const PackageResponse = z.object({
	status: z.int(),
	/** The headers the package manager needs, such as `content-type` and `etag`. */
	headers: z.record(z.string(), z.string()),
	/** The body, base64. */
	body: z.base64(),
})
export type PackageResponse = z.infer<typeof PackageResponse>
