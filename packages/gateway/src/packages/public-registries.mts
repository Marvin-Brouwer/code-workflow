import { publicRegistryHosts, type PublicRegistry } from '@mesh-flow/protocol'

/** Where a public registry is, and the paths on it that are package fetches. */
export interface PublicRegistryEndpoint {
	/** The registry's origin, which is also the host package managers in the sandbox ask for. */
	readonly origin: string
	/** Whether a path, already normalized, fetches a package or its metadata. */
	readonly fetches: (pathname: string) => boolean
}

/** The path prefixes on nuget.org that restore reads from. */
const nugetPathPrefixes = ['/v3/', '/v3-flatcontainer/', '/v3-vulnerabilities/', '/v3-index/']

/**
 * The public registries a run may restore from. nuget.org's v3 feed keeps everything restore reads
 * below `/v3/` (the service index, registrations, the vulnerability index), `/v3-flatcontainer/`
 * (version lists and packages), `/v3-vulnerabilities/` (the vulnerability data NuGet's audit reads)
 * and `/v3-index/` (the repository signatures). On the npm registry, package documents and
 * tarballs are below the package's name; `/-/` is the registry's own API (search, audit, users),
 * which restore doesn't need.
 */
export const publicRegistries: Readonly<Record<PublicRegistry, PublicRegistryEndpoint>> = Object.freeze({
	nuget: {
		origin: `https://${publicRegistryHosts.nuget}`,
		fetches: (pathname) => nugetPathPrefixes.some((prefix) => pathname.startsWith(prefix)),
	},
	npm: {
		origin: `https://${publicRegistryHosts.npm}`,
		fetches: (pathname) => pathname.length > 1 && !pathname.startsWith('/-/'),
	},
})
