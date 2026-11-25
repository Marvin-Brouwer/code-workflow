import { z } from 'zod'

/** An owner as GitHub names one: letters, digits and single hyphens, up to 39 characters. */
const ownerPattern = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/

/** A repository name as GitHub takes one, and never `.` or `..`, which would leave the owner's directory on the host. */
const namePattern = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/

/**
 * A repository as GitHub names it: `owner/name`. A zod schema, for a workflow parameter or a plan's
 * field, that turns down a bare name, a URL and a name GitHub wouldn't take.
 *
 * @example
 * ```ts
 * import { succeed, workflow } from '@mesh-flow/core'
 * import { github } from '@mesh-flow/github'
 * import { developer } from '../agents.mts'
 *
 * export const bump = workflow('bump', { repository: github.RepositoryName }, async ({ parameters }) => {
 * 	const repository = await github.checkout({ repository: parameters.repository, branch: 'chore/bump-node' })
 * 	await developer.loop`Bump Node.js in ${repository}, then ${succeed()}.`
 * })
 * ```
 */
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
	const [owner, repository] = full.split('/')
	if (owner === undefined || repository === undefined) throw new Error(`${full} isn't a repository name: use owner/name.`)
	return { owner, repo: repository }
}

/** Where git clones `owner/name` from on GitHub. */
export function githubRemoteUrl(repository: RepositoryName): string {
	// GitHub ignores case in names: `Team/App` is `team/app`.
	return `https://github.com/${repository.toLowerCase()}.git`
}

/** Whether two repository names name the same repository: GitHub ignores case in them. */
export function sameRepositoryName(one: string, other: string): boolean {
	return one.toLowerCase() === other.toLowerCase()
}

/**
 * A pattern that fits `name` in any case, as GitHub matches repository names: for a check outside
 * zod, such as the JSON Schema the engine checks a webhook delivery against, which reads it with the
 * `u` flag. `name` is a checked `owner/name`, so only `.` means anything in a pattern.
 */
export function anyCasePattern(name: RepositoryName): RegExp {
	const escaped = name.replaceAll('.', String.raw`\.`)
	const anyCase = escaped.replaceAll(/[A-Za-z]/g, (letter) => `[${letter.toUpperCase()}${letter.toLowerCase()}]`)
	return new RegExp(`^${anyCase}$`, 'u')
}
