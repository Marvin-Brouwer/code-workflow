import type { ConnectorRegistry } from '@mesh-flow/protocol'
import { awsConnector } from './connector-name.mts'
import { codeArtifactHost, codeArtifactPaths, CodeArtifactRepository } from './registries/code-artifact-repository.mts'

/**
 * A CodeArtifact repository for the sandbox's `registries`. Package managers in the sandbox, such
 * as `dotnet restore` and `npm ci`, restore from it as the repository's config names it, such as
 * a `nuget.config` with the repository's own URL: the run's proxy takes the fetch, and the host
 * fetches it with a CodeArtifact token from the AWS session. Only reads: nothing can publish
 * through it.
 *
 * ```ts
 * export default defineMeshFlow({
 * 	sandbox: image({
 * 		name: 'node:26-slim',
 * 		registries: ['nuget', codeArtifact({ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' })],
 * 	}),
 * 	workflows: [userTrigger(develop)],
 * })
 * ```
 *
 * Code fetches from it with `fetchPackage` from `@mesh-flow/core`, as from any registry the app
 * restores from:
 *
 * ```ts
 * const packages = codeArtifact({ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' })
 * const index = await fetchPackage({ registry: packages, path: '/nuget/packages/v3/index.json' }, abortSignal)
 * ```
 *
 * @throws When a field isn't a CodeArtifact name, account or region.
 */
export function codeArtifact(repository: CodeArtifactRepository): ConnectorRegistry {
	const { domain, owner, region, repository: name } = CodeArtifactRepository.parse(repository)
	return {
		connector: awsConnector,
		name: `codeartifact ${domain}/${name}`,
		host: codeArtifactHost({ domain, owner, region }),
		paths: codeArtifactPaths({ repository: name }),
		settings: { domain, owner, region, repository: name },
	}
}
