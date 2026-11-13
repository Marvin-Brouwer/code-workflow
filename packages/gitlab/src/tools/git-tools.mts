import { gitTools } from '@mesh-flow/forge'
import { ProjectPath } from '../project-path.mts'

/** The git tools: clone on the host into a bundle for the sandbox, and push what the sandbox bundled. */
export const { cloneRepository, pushBundle } = gitTools({
	prefix: 'gitlab',
	forge: 'GitLab',
	repositoryTerm: 'project',
	repository: ProjectPath,
})
