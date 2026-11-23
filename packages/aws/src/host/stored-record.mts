import type { CredentialReader, CredentialStore } from '@mesh-flow/gateway'
import type { z } from 'zod'

/** What a record kept in the credential store under a name reads as: `undefined` when it isn't there or doesn't read. */
export function parseStored<Value>(text: string | undefined, schema: z.ZodType<Value>): Value | undefined {
	if (text === undefined) return undefined
	try {
		const parsed = schema.safeParse(JSON.parse(text))
		return parsed.success ? parsed.data : undefined
	} catch {
		return undefined
	}
}

/** A JSON record kept in the credential store under `name`, or `undefined` when there is none, or it doesn't read. */
export async function readStored<Value>(
	credentials: CredentialReader,
	name: string,
	schema: z.ZodType<Value>,
	abortSignal: AbortSignal,
): Promise<Value | undefined> {
	return parseStored(await credentials.get(name, abortSignal), schema)
}

/** A record as the credential store keeps it: JSON, checked against its schema first. */
export function serializeStored<Value>(schema: z.ZodType<Value>, value: Value): string {
	return JSON.stringify(schema.parse(value))
}

/** Keeps a JSON record in the credential store under `name`, checked against its schema first. */
export function writeStored<Value>(
	credentials: CredentialStore,
	name: string,
	schema: z.ZodType<Value>,
	value: Value,
	abortSignal: AbortSignal,
): Promise<void> {
	return credentials.set(name, serializeStored(schema, value), abortSignal)
}
