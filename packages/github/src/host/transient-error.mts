import { HostToolTransientError } from '@mesh-flow/gateway'
import { unavailable } from './github-statuses.mts'

/** GitHub's answer to a secondary rate limit, which comes with a `retry-after`. */
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
 * try: a dropped connection, GitHub being unavailable, a rate limit. Anything else, such as a bad
 * token, a missing permission, a 404 or an aborted request, comes back as it is.
 */
export function markedTransient(error: unknown): unknown {
	if (!isRequestFailure(error) || error.name === 'AbortError') return error
	const secondaryRateLimit = error.status === forbidden && error.response?.headers?.['retry-after'] !== undefined
	return unavailable(error.status) || secondaryRateLimit ? new HostToolTransientError(error.message, { cause: error }) : error
}

function isRequestFailure(error: unknown): error is RequestFailure {
	return error instanceof Error && 'status' in error && typeof error.status === 'number'
}
