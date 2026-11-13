import { z } from 'zod'
import { BranchName } from './branch-name.mts'
import { Bundle, Sha } from './bundle-schemas.mts'

/** How a forge names itself and its repositories in its git tools. */
export interface GitToolNames<Repository extends z.ZodType<string>> {
	/** The prefix of the tools' names, such as `github`. */
	readonly prefix: string
	/** The forge's name in the tools' descriptions, such as `GitHub`. */
	readonly forge: string
	/** What the forge calls a repository, such as `repository` or `project`. */
	readonly repositoryTerm: string
	/** The schema of a repository's name on the forge, which also keeps it from leaving the clones' directory. */
	readonly repository: Repository
}

/**
 * The definitions of a forge's git tools: one clones on the host and gives the sandbox a bundle,
 * never the credential, the other pushes what the sandbox bundled, after which the host checks the
 * branch is at the bundle's head.
 */
export function gitTools<Repository extends z.ZodType<string>>({ prefix, forge, repositoryTerm, repository }: GitToolNames<Repository>) {
	return {
		cloneRepository: {
			name: `${prefix}Clone`,
			description: `Fetches a ${forge} ${repositoryTerm} on the host and returns it as a git bundle holding its default branch and, when it exists, the branch`,
			input: z.object({ repository, branch: BranchName }),
			output: z.object({
				bundle: Bundle,
				defaultBranch: BranchName,
				/** Whether the branch exists on the forge. When it doesn't, the bundle holds the default branch only. */
				branchExists: z.boolean(),
			}),
		},
		pushBundle: {
			name: `${prefix}Push`,
			description: `Pushes the commits in a git bundle to a branch of a ${forge} ${repositoryTerm}`,
			input: z.object({ repository, branch: BranchName, bundle: Bundle }),
			output: z.object({ head: Sha }),
		},
	}
}

/** A forge's git tools, as {@link gitTools} defines them. */
export type GitTools = ReturnType<typeof gitTools<z.ZodType<string>>>
