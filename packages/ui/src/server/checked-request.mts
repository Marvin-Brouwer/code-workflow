import { validator } from 'hono/validator'
import { z } from 'zod'

/** The 400 answer to a request that doesn't fit `schema`: a bad request is an answer, not a throw. */
function badRequest(error: z.ZodError) {
	return { error: `Bad request: ${z.prettifyError(error)}` }
}

/** Checks a request's JSON body against `schema`, for `context.req.valid('json')`; answers 400 when it doesn't fit. */
export function jsonBody<Schema extends z.ZodType>(schema: Schema) {
	return validator('json', (value, context) => {
		const checked = schema.safeParse(value)
		return checked.success ? checked.data : context.json(badRequest(checked.error), 400)
	})
}

/** Checks a request's path parameters against `schema`, for `context.req.valid('param')`; answers 400 when they don't fit. */
export function pathParameters<Schema extends z.ZodType>(schema: Schema) {
	return validator('param', (value, context) => {
		const checked = schema.safeParse(value)
		return checked.success ? checked.data : context.json(badRequest(checked.error), 400)
	})
}
