import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { searchProjects } from '../tools/project-tools.mts'
import type { ApiClient } from './api.mts'

/** A project as GitLab's search lists it, in the fields the tool passes on. */
const ApiProject = z.object({
	path_with_namespace: z.string(),
	name: z.string(),
	description: z.string().nullable().optional(),
	web_url: z.url(),
	default_branch: z.string().nullable().optional(),
})

/** The host half of the project search. */
export function projectHostTools(api: ApiClient): HostTool[] {
	return [
		hostTool(searchProjects, async ({ query, limit }, context) => {
			const client = await api(context)
			const { items, more } = await client.firstPage('/projects', ApiProject, limit, {
				search: query,
				// The path too, so `backend/api` finds the project of that path.
				search_namespaces: true,
				membership: true,
				simple: true,
				order_by: 'last_activity_at',
			})
			const projects = items.map((project) => ({
				repository: project.path_with_namespace,
				name: project.name,
				description: project.description ?? '',
				url: project.web_url,
				...(project.default_branch === null || project.default_branch === undefined ? {} : { defaultBranch: project.default_branch }),
			}))
			return { projects, more }
		}),
	]
}
