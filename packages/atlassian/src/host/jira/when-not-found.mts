import { isNotFoundError } from 'jira.js'

/** What `call` resolves to, or `fallback` when Jira answers that what it asks for isn't there. */
export async function orWhenNotFound<T, Fallback>(call: () => Promise<T>, fallback: Fallback): Promise<T | Fallback> {
	try {
		return await call()
	} catch (error) {
		if (isNotFoundError(error)) return fallback
		throw error
	}
}
