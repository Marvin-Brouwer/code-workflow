import { gitTools } from '@mesh-flow/forge'
import { gitlabTerms } from '../merge-request/gitlab-terms.mts'
import { ProjectPath } from '../project-path.mts'

/** The git tools: clone on the host into a bundle for the sandbox, and push what the sandbox bundled. */
export const { cloneRepository, pushBundle } = gitTools({ terms: gitlabTerms, repositoryTerm: 'project', repository: ProjectPath })
