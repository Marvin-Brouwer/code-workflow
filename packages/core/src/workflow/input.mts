import { z } from 'zod'
import { waitingOnHuman } from '../loop/loop-clock.mts'
import { emitEvent, inEvent } from '../run/run-events.mts'
import { jsonSchemaOf } from '../tool/json-schema.mts'
import { inputField } from './input-fields.mts'

/**
 * Asks a human for typed input and waits for the answer. The engine shows the question and the
 * fields as a form; the answer is checked against them here, and an answer that doesn't fit is
 * asked again. Fields are zod schemas, and `input` has the common kinds, the same an agent gets with
 * `requestUserInput`: `input.text()`, `input.yesNo()`, `input.choice(options)` and
 * `input.choices(options)`.
 *
 * ```ts
 * const { key } = await input('Which story should be developed?', { key: z.string().regex(/^[A-Z]+-\d+$/) })
 * const release = await input('How should the release go?', {
 * 	tagged: input.yesNo('Is the release tagged yet?'),
 * 	channel: input.choice(['stable', 'beta']),
 * 	platforms: input.choices(['web', 'ios', 'android']),
 * })
 * ```
 *
 * Inside a loop (from a tool such as `requestUserInput`), the wait doesn't count toward the loop's
 * `limit`.
 */
export const input = Object.freeze(Object.assign(askForInput, inputField))

async function askForInput<Shape extends z.ZodRawShape>(question: string, fields: Shape): Promise<z.output<z.ZodObject<Shape>>> {
	const schema = z.object(fields)
	const fieldSchemas = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, jsonSchemaOf(field)]))
	return inEvent('input', { question }, async (scope) => {
		let asked = question
		for (;;) {
			const id = `input-${scope.run.count('input')}`
			scope.run.channel.send({ type: 'request', request: { kind: 'input', id, question: asked, fields: fieldSchemas } })
			const { value } = await waitingOnHuman(() => scope.run.channel.answer(id, scope.run.abortSignal))
			const parsed = schema.safeParse(value)
			if (parsed.success) {
				emitEvent(scope, 'input-answered', { request: id })
				return parsed.data
			}
			const problem = z.prettifyError(parsed.error)
			emitEvent(scope, 'input-refused', { request: id, problem })
			asked = `${question}\n\nThe last answer didn't fit:\n${problem}`
		}
	})
}
