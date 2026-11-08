import { z } from 'zod'

/** A workflow's name: its file in the workflows folder without `.mts`, in folders separated by `/`. */
export const WorkflowName = z
	.string()
	.regex(/^[\w-]+(?:\/[\w-]+)*$/, "A workflow name is letters, digits, '_' and '-', in folders separated by '/'.")
