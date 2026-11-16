import { BranchName } from '@mesh-flow/code-repository'
import { z } from 'zod'
import { ProjectPath } from '../project-path.mts'

/** A repository, a GitLab project, as a search finds it. */
export const FoundRepository = z.object({
	repository: ProjectPath,
	name: z.string(),
	description: z.string(),
	url: z.url(),
	/** Absent for a project without commits. */
	defaultBranch: BranchName.optional(),
})
export type FoundRepository = z.infer<typeof FoundRepository>

/** The most repositories a search lists: one page of GitLab's list. */
const maxSearchLimit = 100

/** How many repositories a search lists when no limit is given. */
const defaultSearchLimit = 20

/**
 * Searches on the host the GitLab projects the user of the token is a member of, by words in their
 * name, path or description: a tool for agents that have to find where a change goes, and a
 * function for code. Each comes with its path, which `gitlab.checkout` takes as its `repository`.
 */
export const searchRepositories = {
	name: 'gitlabSearchRepositories',
	description: 'Searches the GitLab projects the user of the token is a member of by name, path or description',
	input: z.object({
		query: z.string().min(1).describe('Words in the name, path or description'),
		limit: z.int().min(1).max(maxSearchLimit).default(defaultSearchLimit).describe('The most repositories to list'),
	}),
	output: z.object({ repositories: z.array(FoundRepository), more: z.boolean() }),
}
