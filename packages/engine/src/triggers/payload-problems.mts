import type { JsonSchema } from '@mesh-flow/protocol'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'

const ajv = new Ajv2020({ allErrors: true, strict: false })
const compiled = new Map<string, ValidateFunction>()

/** The most problems an answer lists; the rest are left out. */
const shownProblems = 10

/**
 * What doesn't fit `schema` in `payload`, as one line per problem; none when it fits. Schemas come
 * from entry file descriptions, which change rarely, so each is compiled once.
 */
export function payloadProblems(schema: JsonSchema, payload: unknown): string[] {
	const text = JSON.stringify(schema)
	let validate = compiled.get(text)
	if (validate === undefined) {
		validate = ajv.compile(schema)
		compiled.set(text, validate)
	}
	if (validate(payload)) return []
	return (validate.errors ?? []).slice(0, shownProblems).map((error) => `${error.instancePath || '/'} ${error.message ?? 'does not fit'}`)
}
