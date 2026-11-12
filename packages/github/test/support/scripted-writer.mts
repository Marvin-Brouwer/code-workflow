import { toPrompt, type Agent } from '@mesh-flow/core'
import { z } from 'zod'
import type { PullRequestText } from '../../src/pull-request/pull-request-text.mts'

/** Where a prompt made by core's `prompt` keeps its parts: a registered symbol, the same in every module. */
const promptParts = Symbol.for('mesh-flow.prompt')
/** The parts a prompt keeps under {@link promptParts}. */
const PromptParts = z.object({ strings: z.array(z.string()), values: z.array(z.unknown()) })

/**
 * A template as the loop would show it, near enough: nested prompts in place, values that render
 * themselves as they do. Every line loses its indentation, where the loop takes off only the source's.
 */
function rendered(strings: readonly string[], values: readonly unknown[]): string {
	return strings.reduce((text, part, index) => {
		if (index === 0) return part
		return `${text}${shown(values[index - 1])}${part}`
	}, '')
}

/** One value as the loop renders it in a template, near enough. */
function shown(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number') return String(value)
	if (typeof value === 'object' && value !== null && promptParts in value) {
		const { strings, values } = PromptParts.parse(Reflect.get(value, promptParts))
		return rendered(strings, values)
	}
	if ((typeof value === 'object' || typeof value === 'function') && value !== null && toPrompt in value) {
		const render: unknown = Reflect.get(value, toPrompt)
		if (typeof render === 'function') return String(render.call(value))
	}
	if (typeof value === 'function') return value.name
	return '(a value)'
}

/** An agent whose loops answer with `texts`, one each, and keep the prompts they got. */
export function scriptedWriter(texts: readonly PullRequestText[]) {
	const queue = [...texts]
	const prompts: string[] = []
	const loop = (strings: TemplateStringsArray, ...values: unknown[]) => {
		prompts.push(rendered(strings, values).replace(/^[ \t]+/gm, ''))
		const text = queue.shift()
		return text === undefined ? Promise.reject(new Error('The writer has nothing more to write.')) : Promise.resolve(text)
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in for a model: `loop` answers whatever its template asks for
	const writer = { model: 'test-writer', loop, as: () => undefined } as unknown as Agent
	return { writer, prompts }
}
