import { tool } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import { searchProjects } from '../tools/project-tools.mts'

/**
 * The tool that searches the GitLab projects the token can see, by words in their name, path or
 * description, for an agent that has to find where a change goes. Each project comes with its
 * path, which `gitlab.checkout` takes.
 *
 * ```ts
 * await planner.loop`Find the projects ${story} touches with ${gitlab.searchRepositories}.`
 * ```
 */
export const searchRepositories = tool('searchRepositories', {
	description: 'Searches the GitLab projects the token can see by name, path or description',
	input: searchProjects.input,
	action: (input, context) => stubs.searchProjects(input, context),
})
