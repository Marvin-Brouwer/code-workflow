import { BranchName } from '@mesh-flow/forge'
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

/** Searches on the host the projects the token can see. */
export const searchProjects = {
	name: 'gitlabSearchProjects',
	description: 'Searches the GitLab projects the token can see by name, path or description',
	input: z.object({
		query: z.string().min(1).describe('Words in the name, path or description'),
		limit: z.int().min(1).max(100).default(20).describe('The most projects to list'),
	}),
	output: z.object({ projects: z.array(FoundProject), more: z.boolean() }),
}
