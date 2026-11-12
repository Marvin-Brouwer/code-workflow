import { z } from 'zod'

/** An owner as GitHub names one: letters, digits and single hyphens, up to 39 characters. */
const ownerPattern = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/

/** A repository name as GitHub takes one, and never `.` or `..`, which would leave the owner's directory on the host. */
const namePattern = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/

/** A repository as GitHub names it: `owner/name`. */
export const RepositoryName = z.string().refine(
	(full) => {
		const parts = full.split('/')
		return parts.length === 2 && ownerPattern.test(parts[0] ?? '') && namePattern.test(parts[1] ?? '')
	},
	{ message: 'Use owner/name, as on GitHub.' },
)
export type RepositoryName = z.infer<typeof RepositoryName>

/** The owner and the name in `owner/name`. */
export function splitRepositoryName(full: RepositoryName): { readonly owner: string; readonly repo: string } {
	const [owner, repo] = full.split('/')
	if (owner === undefined || repo === undefined) throw new Error(`${full} isn't a repository name: use owner/name.`)
	return { owner, repo }
}

/** Where git clones `owner/name` from on GitHub. */
export function githubRemoteUrl(repository: RepositoryName): string {
	return `https://github.com/${repository}.git`
}

export { BranchName } from '@mesh-flow/forge'

/** Whether two repository names name the same repository: GitHub ignores case in them. */
export function sameRepositoryName(one: string, other: string): boolean {
	return one.toLowerCase() === other.toLowerCase()
}
