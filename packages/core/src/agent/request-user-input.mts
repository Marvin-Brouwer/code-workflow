import { z } from 'zod'
import { tool } from '../tool/tool.mts'
import { input } from '../workflow/input.mts'
import { AgentInputField, fieldSchema } from '../workflow/input-fields.mts'

/** Field names an agent may use: they become keys of the answer. */
const fieldNamePattern = /^[A-Za-z]\w{0,63}$/

/**
 * Lets an agent ask the user mid-loop and wait for the answer: one question with a text answer, or a
 * form with the same kinds of field a workflow's `input` has (text, yes or no, a choice, several
 * choices). The wait doesn't count toward the loop's `limit`.
 *
 * ```ts
 * system: prompt`When anything is unclear, ${requestUserInput} instead of guessing.`
 * ```
 */
export const requestUserInput = tool('requestUserInput', {
	description:
		'Ask the user and wait for the answer. Use it when something is unclear, instead of guessing. Without fields the answer is text; with fields the user fills in a form and you get an object with one answer per field.',
	input: z.object({
		question: z.string().describe('The question, with the context the user needs to answer it'),
		fields: z
			.record(z.string().regex(fieldNamePattern), AgentInputField)
			.optional()
			.describe('A form instead of a text answer, by field name: text, yesNo, choice (one of options) or choices (some of options)'),
	}),
	action: async ({ question, fields }) => {
		if (fields === undefined || Object.keys(fields).length === 0)
			return (await input(question, { answer: z.string().describe('The answer') })).answer
		return input(question, Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldSchema(field)])))
	},
})
