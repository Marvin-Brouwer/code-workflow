import { packageRegistryHosts, type PublicRegistry as PublicRegistryName } from '@mesh-flow/protocol'

/** Where a public registry is, and the paths on it that are package fetches. */
export interface PublicRegistry {
	/** The registry's origin, which is also the host package managers in the sandbox ask for. */
	readonly origin: string
	/** Whether a path, already normalized, fetches a package or its metadata. */
	readonly fetches: (pathname: string) => boolean
}

/**
 * The public registries a run may restore from. nuget.org's v3 feed keeps everything restore reads
 * below `/v3/` (the service index, registrations, vulnerability data) and `/v3-flatcontainer/`
 * (version lists and packages). On the npm registry, package documents and tarballs are below the
 * package's name; `/-/` is the registry's own API (search, audit, users), which restore doesn't need.
 */
export const publicRegistries: Readonly<Record<PublicRegistryName, PublicRegistry>> = Object.freeze({
	nuget: {
		origin: `https://${packageRegistryHosts.nuget}`,
		fetches: (pathname) => pathname.startsWith('/v3/') || pathname.startsWith('/v3-flatcontainer/'),
	},
	npm: {
		origin: `https://${packageRegistryHosts.npm}`,
		fetches: (pathname) => pathname.length > 1 && !pathname.startsWith('/-/'),
	},
})
