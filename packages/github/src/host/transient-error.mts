import { HostToolTransientError } from '@mesh-flow/gateway'
import { unavailable } from './github-statuses.mts'

/** GitHub's answer to a missing permission, and to a rate limit, told apart by the headers. */
const forbidden = 403

/** What Octokit's `RequestError` holds that says whether a failure may pass. */
interface RequestFailure {
	readonly name: string
	readonly message: string
	readonly status: number
	readonly response?: { readonly headers?: Record<string, unknown> }
}

/**
 * A failure from Octokit, marked as a {@link HostToolTransientError} when it may pass on another
 * try: a dropped connection, GitHub being unavailable, a rate limit (429, or a 403 that says so). Anything else, such as a bad
 * token, a missing permission, a 404 or an aborted request, comes back as it is.
 */
export function markedTransient(error: unknown): unknown {
	if (!isRequestFailure(error) || error.name === 'AbortError') return error
	const headers = error.response?.headers
	// A 403 is a rate limit too: a secondary one with `retry-after`, a primary one with no requests left until the reset.
	const rateLimited = error.status === forbidden && (headers?.['retry-after'] !== undefined || headers?.['x-ratelimit-remaining'] === '0')
	return unavailable(error.status) || rateLimited ? new HostToolTransientError(error.message, { cause: error }) : error
}

function isRequestFailure(error: unknown): error is RequestFailure {
	return error instanceof Error && 'status' in error && typeof error.status === 'number'
}
