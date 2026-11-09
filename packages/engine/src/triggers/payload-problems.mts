import type { JsonSchema } from '@mesh-flow/protocol'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'

// Formats zod emits, such as `email`, aren't checked here: the schema checks them in the sandbox.
const ajv = new Ajv2020({ allErrors: true, strict: false, logger: false })
const compiled = new Map<string, ValidateFunction>()

/** The most problems an answer lists; the rest are left out. */
const maxShownProblems = 10

/** The most compiled schemas kept. Descriptions change rarely; old versions' schemas go first. */
const maxCompiledSchemas = 100

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
		const [oldest] = compiled
		if (compiled.size > maxCompiledSchemas && oldest !== undefined) {
			const [oldestText, oldestValidate] = oldest
			compiled.delete(oldestText)
			// Ajv keeps every schema it compiled, by the schema object itself.
			ajv.removeSchema(oldestValidate.schema)
		}
	}
	if (validate(payload)) return []
	return (validate.errors ?? [])
		.slice(0, maxShownProblems)
		.map((error) => `${error.instancePath || '/'} ${error.message ?? 'does not fit'}`)
}
