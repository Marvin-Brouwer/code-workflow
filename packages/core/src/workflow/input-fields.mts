import { z } from 'zod'

/**
 * The kinds of field a form asks for, the same for a workflow's `input` (as `input.text()` and so
 * on) and an agent's `requestUserInput`: free text, yes or no, one of a few options, or several.
 */
export const inputField = Object.freeze({
	text: (description?: string) => described(z.string(), description),
	yesNo: (description?: string) => described(z.boolean(), description),
	choice: <const Options extends readonly [string, ...string[]]>(options: Options, description?: string) =>
		described(z.enum(options), description),
	choices: <const Options extends readonly [string, ...string[]]>(options: Options, description?: string) =>
		described(z.array(z.enum(options)), description),
})

/** A field as an agent describes it to `requestUserInput`. */
export const AgentInputField = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('text'), description: z.string().optional() }),
	z.object({ kind: z.literal('yesNo'), description: z.string().optional() }),
	z.object({ kind: z.literal('choice'), options: z.array(z.string()).min(1), description: z.string().optional() }),
	z.object({ kind: z.literal('choices'), options: z.array(z.string()).min(1), description: z.string().optional() }),
])
export type AgentInputField = z.infer<typeof AgentInputField>

/** The schema of a field an agent described. */
export function fieldSchema(field: AgentInputField): z.ZodType {
	if (field.kind === 'text') return inputField.text(field.description)
	if (field.kind === 'yesNo') return inputField.yesNo(field.description)
	const [first, ...rest] = field.options
	// The schema already says there is one option at least; this tells the compiler.
	if (first === undefined) throw new Error('A choice needs at least one option.')
	return field.kind === 'choice'
		? inputField.choice([first, ...rest], field.description)
		: inputField.choices([first, ...rest], field.description)
}

function described<Schema extends z.ZodType>(schema: Schema, description: string | undefined): Schema {
	return description === undefined ? schema : schema.describe(description)
}
