import { z } from 'zod'
import { waitingOnHuman } from '../loop/loop-clock.mts'
import { emitEvent, inEvent } from '../run/run-events.mts'
import { jsonSchemaOf } from '../tool/json-schema.mts'

/**
 * Asks a human for typed input and waits for the answer. The engine shows the question and the
 * fields; the answer is checked against them here, and an answer that doesn't fit is asked again.
 *
 * ```ts
 * const { key } = await input('Which story should be developed?', { key: z.string().regex(/^[A-Z]+-\d+$/) })
 * ```
 *
 * Inside a loop (from a tool such as `requestUserInput`), the wait doesn't count toward the loop's
 * `limit`.
 */
export async function input<Shape extends z.ZodRawShape>(question: string, fields: Shape): Promise<z.output<z.ZodObject<Shape>>> {
	const schema = z.object(fields)
	const fieldSchemas = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, jsonSchemaOf(field)]))
	return inEvent('input', { question }, async (scope) => {
		let asked = question
		for (;;) {
			const id = `input-${scope.run.count('input')}`
			scope.run.channel.send({ type: 'request', request: { kind: 'input', id, question: asked, fields: fieldSchemas } })
			const { value } = await waitingOnHuman(() => scope.run.channel.answer(id, scope.run.signal))
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
