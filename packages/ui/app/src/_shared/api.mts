import type { z } from 'zod'

/**
 * What the UI's API answered: the value, or why there is none, with the HTTP status when the
 * server answered. A refusal is an answer, not a throw.
 */
export type Answer<Value> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly error: string; readonly status?: number | undefined }

/** Reads `path` of the UI's API, checked against `schema`. */
export function read<Value>(path: string, schema: z.ZodType<Value>, abortSignal: AbortSignal): Promise<Answer<Value>> {
	return call(path, schema, { method: 'GET', signal: abortSignal })
}

/** Sends a change to `path` of the UI's API as JSON, and checks the answer against `schema`. */
export function send<Value>(
	method: 'POST' | 'PUT' | 'DELETE',
	path: string,
	body: unknown,
	schema: z.ZodType<Value>,
	abortSignal: AbortSignal,
): Promise<Answer<Value>> {
	return call(path, schema, {
		method,
		signal: abortSignal,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	})
}

async function call<Value>(path: string, schema: z.ZodType<Value>, init: RequestInit): Promise<Answer<Value>> {
	let response: Response
	try {
		response = await fetch(`/api${path}`, init)
	} catch (error) {
		return { ok: false, error: `The UI's server didn't answer: ${error instanceof Error ? error.message : String(error)}` }
	}
	const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined)
	if (!response.ok)
		return { ok: false, error: errorOf(body) ?? `The UI's server answered ${String(response.status)}.`, status: response.status }
	const checked = schema.safeParse(body)
	return checked.success ? { ok: true, value: checked.data } : { ok: false, error: `The answer didn't fit: ${checked.error.message}` }
}

function errorOf(body: unknown): string | undefined {
	if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
	return typeof body.error === 'string' ? body.error : undefined
}
