import { gitTools } from '@mesh-flow/code-repository'
import { githubTerms } from '../pull-request/github-terms.mts'
import { RepositoryName } from '../repository-name.mts'

/** The git tools: clone on the host into a bundle for the sandbox, and push what the sandbox bundled. */
export const { cloneRepository, pushBundle } = gitTools({
	terms: githubTerms,
	repositoryTerm: 'repository',
	repository: RepositoryName,
})
