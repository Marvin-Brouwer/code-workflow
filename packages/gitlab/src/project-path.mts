import { z } from 'zod'

/** A segment of a project's path as GitLab takes one, and never `.` or `..`, which would leave the clones' directory on the host. */
const segmentPattern = /^(?!\.\.?$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/

/** A project as GitLab names it: its path with its group and subgroups, such as `team/backend/api`. */
export const ProjectPath = z.string().refine(
	(full) => {
		const segments = full.split('/')
		return segments.length >= 2 && segments.every((segment) => segmentPattern.test(segment) && !segment.endsWith('.git'))
	},
	{ message: 'Use the path of the project with its group, such as team/api, as on GitLab.' },
)
export type ProjectPath = z.infer<typeof ProjectPath>

/** Whether two paths name the same project: GitLab ignores case in them. */
export function sameProjectPath(one: string, other: string): boolean {
	return one.toLowerCase() === other.toLowerCase()
}

/**
 * What a checkout's `origin` is set to. The sandbox never fetches from it, since clones and pushes
 * go through the host, so it names the project rather than a URL, which only the host knows.
 */
export function gitlabRemoteName(project: ProjectPath): string {
	return `gitlab:${project}`
}
