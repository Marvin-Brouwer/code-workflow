import { z } from 'zod'

/** JSON Schema of the input `schema` accepts, as a plain object, for models and the engine. */
export function jsonSchemaOf(schema: z.core.$ZodType): Record<string, unknown> {
	const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
	return rest
}

/**
 * Tool parameters must be a JSON object. An object schema is used as it is; anything else is
 * wrapped in `{ value }`, and {@link ToolParameters.unwrap} takes it out again.
 */
export interface ToolParameters {
	readonly parameters: Record<string, unknown>
	readonly unwrap: (args: unknown) => unknown
}

/** The tool parameters for an input schema, and how to take the input out of the arguments again. */
export function toolParameters(schema: z.ZodType | undefined): ToolParameters {
	if (schema === undefined) return { parameters: { type: 'object', properties: {} }, unwrap: () => undefined }
	if (schema instanceof z.ZodObject) return { parameters: jsonSchemaOf(schema), unwrap: (args) => args }
	return {
		parameters: jsonSchemaOf(z.object({ value: schema })),
		unwrap: (args) => (typeof args === 'object' && args !== null && 'value' in args ? args.value : undefined),
	}
}
