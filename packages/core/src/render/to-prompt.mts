/**
 * Lets a value decide how it appears in a prompt. A story can render as the path of its Markdown
 * dump, a folder as its path and a listing, so a prompt never gets more of a value than the agent
 * needs ([design: Context](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#context)).
 *
 * ```ts
 * const story = { key: 'ABC-1', path: 'stories/ABC-1.md', [toPrompt]: () => 'stories/ABC-1.md' }
 * ```
 *
 * A registered symbol, so values made with another copy of this package render the same.
 */
export const toPrompt: unique symbol = Symbol.for('mesh-flow.to-prompt')

/** A value with its own rendering. */
export interface RendersInPrompt {
	[toPrompt](): string | Promise<string>
}

/**
 * A value as prompt text. Strings stay as they are, values with {@link toPrompt} render
 * themselves, other primitives become their text, and anything else becomes indented JSON.
 */
export async function renderValue(value: unknown): Promise<string> {
	if (typeof value === 'string') return value
	if (value === undefined || value === null) return ''
	if (rendersInPrompt(value)) return value[toPrompt]()
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString()
	if (value instanceof Date) return value.toISOString()
	if (typeof value === 'symbol') return value.toString()
	if (typeof value === 'function') return value.name
	return JSON.stringify(value, null, '\t')
}

function rendersInPrompt(value: unknown): value is RendersInPrompt {
	return (
		(typeof value === 'object' || typeof value === 'function') &&
		value !== null &&
		typeof (value as Partial<RendersInPrompt>)[toPrompt] === 'function'
	)
}
