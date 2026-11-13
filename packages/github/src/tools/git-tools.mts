import { Bundle, gitTools, Sha } from '@mesh-flow/forge'
import { RepositoryName } from '../repository-name.mts'

export { Bundle, Sha }

/** The git tools: clone on the host into a bundle for the sandbox, and push what the sandbox bundled. */
export const { cloneRepository, pushBundle } = gitTools({
	prefix: 'github',
	forge: 'GitHub',
	repositoryTerm: 'repository',
	repository: RepositoryName,
})
