import { z } from 'zod'
import type { CodeHostTerms } from '../describe/change-request.mts'
import { BranchName } from './branch-name.mts'
import { Bundle, Sha } from './bundle-schemas.mts'

/** How a code host names itself and its repositories in its git tools. */
export interface GitToolNames<Repository extends z.ZodType<string>> {
	/** The code host's terms: its name for the descriptions, and the prefix of the tools' names. */
	readonly terms: Pick<CodeHostTerms, 'name' | 'toolPrefix'>
	/** What the code host calls a repository, such as `repository` or `project`. */
	readonly repositoryTerm: string
	/** The schema of a repository's name on the code host, which also keeps it from leaving the clones' directory. */
	readonly repository: Repository
}

/**
 * The definitions of a code host's git tools: one clones on the host and gives the sandbox a bundle,
 * never the credential, the other pushes what the sandbox bundled, after which the host checks the
 * branch is at the bundle's head.
 */
export function gitTools<Repository extends z.ZodType<string>>({ terms, repositoryTerm, repository }: GitToolNames<Repository>) {
	const { toolPrefix } = terms
	return {
		cloneRepository: {
			name: `${toolPrefix}Clone`,
			description: `Fetches a ${terms.name} ${repositoryTerm} on the host and returns it as a git bundle holding its default branch and, when it exists, the branch`,
			input: z.object({ repository, branch: BranchName }),
			output: z.object({
				bundle: Bundle,
				defaultBranch: BranchName,
				/** Whether the branch exists on the code host. When it doesn't, the bundle holds the default branch only. */
				branchExists: z.boolean(),
			}),
		},
		pushBundle: {
			name: `${toolPrefix}Push`,
			description: `Pushes the commits in a git bundle to a branch of a ${terms.name} ${repositoryTerm}`,
			input: z.object({ repository, branch: BranchName, bundle: Bundle }),
			output: z.object({ head: Sha }),
		},
	}
}

/** A code host's git tools, as {@link gitTools} defines them. */
export type GitTools = ReturnType<typeof gitTools<z.ZodType<string>>>
