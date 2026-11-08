import { z } from 'zod'
import { tool } from '../tool/tool.mts'
import { input } from '../workflow/input.mts'

/**
 * Lets an agent ask the user a question mid-loop and wait for the answer. The wait doesn't count
 * toward the loop's `limit`.
 *
 * ```ts
 * system: prompt`When anything is unclear, ${requestUserInput} instead of guessing.`
 * ```
 */
export const requestUserInput = tool('requestUserInput', {
	description: 'Ask the user a question and wait for the answer. Use it when something is unclear, instead of guessing.',
	input: z.object({ question: z.string().describe('The question, with the context the user needs to answer it') }),
	action: async ({ question }) => (await input(question, { answer: z.string().describe('The answer') })).answer,
})
