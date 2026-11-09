import { tool } from '@mesh-flow/core'
import { git, type Repository } from '@mesh-flow/git'
import { z } from 'zod'
import { api } from './api.mts'

export function checkout(project: string, options: { branch: string }): Promise<Repository> {
	return git.checkout(project, options)
}

export const searchRepositories = tool('searchRepositories', {
	description: 'Search projects on GitLab by name or description.',
	input: z.object({ query: z.string() }),
	action: ({ query }) => api.searchProjects(query),
})

export function push(repository: Repository) {
	return tool('push', {
		description: `Commit all changes in ${repository.name} and push them.`,
		input: z.object({ message: z.string() }),
		async action({ message }) {
			await git.commitAll(repository, message)
			await git.push(repository)
			return { pushed: true }
		},
	})
}
