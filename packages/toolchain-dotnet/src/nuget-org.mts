import type { PublicRegistry } from '@mesh-flow/core'

/**
 * nuget.org's v3 feed, for the sandbox's `registries`: `dotnet restore` in the sandbox then
 * restores from it through the run's package proxy. Restore reads everything below `/v3/` (the
 * service index, registrations, the vulnerability index), `/v3-flatcontainer/` (version lists
 * and packages), `/v3-vulnerabilities/` (the vulnerability data NuGet's audit reads) and
 * `/v3-index/` (the repository signatures); nothing else on the host is reachable.
 *
 * ```ts
 * import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
 * import { nugetOrg } from '@mesh-flow/toolchain-dotnet'
 *
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:26-slim', registries: [nugetOrg] }),
 * 	workflows: [userTrigger(develop)],
 * })
 * ```
 */
export const nugetOrg: PublicRegistry = Object.freeze({
	name: 'nuget.org',
	host: 'api.nuget.org',
	paths: ['/v3/', '/v3-flatcontainer/', '/v3-vulnerabilities/', '/v3-index/'],
})
