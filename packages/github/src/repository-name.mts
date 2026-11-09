import { z } from 'zod'

/** A repository as GitHub names it: `owner/name`. */
export const RepositoryName = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Use owner/name, as on GitHub.')
export type RepositoryName = z.infer<typeof RepositoryName>

/** The owner and the name in `owner/name`. */
export function splitRepositoryName(full: RepositoryName): { readonly owner: string; readonly repo: string } {
	const [owner, repo] = full.split('/')
	if (owner === undefined || repo === undefined) throw new Error(`${full} isn't a repository name: use owner/name.`)
	return { owner, repo }
}

/** A branch name, as git takes it in a ref. */
export const BranchName = z
	.string()
	.regex(/^(?!.*(\.\.|\/\/|@\{))[^\s~^:?*[\\]+$/, "Use a branch name git takes: no spaces, '..', '~', '^', ':', '?', '*', '[' or '\\'.")
	.refine(
		(name) => !name.startsWith('-') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock'),
		"A branch name doesn't start with '-' or end with '/', '.' or '.lock'.",
	)
export type BranchName = z.infer<typeof BranchName>
