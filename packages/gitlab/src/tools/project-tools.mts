import { BranchName } from '@mesh-flow/code-repository'
import { z } from 'zod'
import { ProjectPath } from '../project-path.mts'

/** A project as a search finds it. */
export const FoundProject = z.object({
	repository: ProjectPath,
	name: z.string(),
	description: z.string(),
	url: z.url(),
	/** Absent for a project without commits. */
	defaultBranch: BranchName.optional(),
})
export type FoundProject = z.infer<typeof FoundProject>

/** The most projects a search lists: one page of GitLab's list. */
const maxProjectSearchLimit = 100

/** How many projects a search lists when no limit is given. */
const defaultProjectSearchLimit = 20

/** Searches on the host the projects the user of the token is a member of. */
export const searchProjects = {
	name: 'gitlabSearchProjects',
	description: 'Searches the GitLab projects the user of the token is a member of by name, path or description',
	input: z.object({
		query: z.string().min(1).describe('Words in the name, path or description'),
		limit: z.int().min(1).max(maxProjectSearchLimit).default(defaultProjectSearchLimit).describe('The most projects to list'),
	}),
	output: z.object({ projects: z.array(FoundProject), more: z.boolean() }),
}
