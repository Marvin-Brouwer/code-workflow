import type { PublicRegistry } from '@mesh-flow/protocol'

// Copies of the real definitions, which tests here can't import: they depend on core.

/** The npm registry, as `npmRegistry` of `@mesh-flow/toolchain-node` defines it. */
export const npmRegistry: PublicRegistry = {
	name: 'npm',
	host: 'registry.npmjs.org',
	paths: ['/'],
	excludedPaths: ['/-/'],
}

/** nuget.org's v3 feed, as `nugetOrg` of `@mesh-flow/toolchain-dotnet` defines it. */
export const nugetOrg: PublicRegistry = {
	name: 'nuget.org',
	host: 'api.nuget.org',
	paths: ['/v3/', '/v3-flatcontainer/', '/v3-vulnerabilities/', '/v3-index/'],
}
