import { z } from 'zod'

/** A branch name, as git takes it in a ref. */
export const BranchName = z
	.string()
	.regex(/^(?!.*(\.\.|\/\/|@\{))[^\s~^:?*[\\]+$/, "Use a branch name git takes: no spaces, '..', '~', '^', ':', '?', '*', '[' or '\\'.")
	.refine(
		(name) => !name.startsWith('-') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock'),
		"A branch name doesn't start with '-' or end with '/', '.' or '.lock'.",
	)
export type BranchName = z.infer<typeof BranchName>
