import { HostToolTransientError } from '@mesh-flow/gateway'
import { isNetworkError, isRateLimitError, isServerError } from 'jira.js'

/**
 * Whether a failure is one that may pass on another try: a dropped connection, a 5xx or a rate
 * limit. A network failure that won't, such as a host name that doesn't resolve or a bad
 * certificate, is a mistake in the settings, and doesn't.
 */
export function mayPass(error: unknown): boolean {
	return (isNetworkError(error) && error.transient) || isServerError(error) || isRateLimitError(error)
}

/**
 * Runs a call to an Atlassian product and marks a failure that may pass, after the client's own
 * retries, as a {@link HostToolTransientError}, so a caller that waits can look again later.
 * Anything else, such as a bad token, a missing permission, a 404 or an abort, comes back as it is.
 */
export async function markingTransient<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call()
	} catch (error) {
		if (mayPass(error)) throw new HostToolTransientError(error instanceof Error ? error.message : String(error), { cause: error })
		throw error
	}
}
