import { HostToolTransientError } from '@mesh-flow/gateway'

/** GitHub's answer to too many requests. */
const tooManyRequests = 429

/** From here up, GitHub couldn't serve the request; Octokit also reports a dropped connection as 500. */
const firstServerError = 500

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
 * A failure from Octokit as a {@link HostToolTransientError} when it may pass on another try: a
 * dropped connection, a 5xx, a rate limit. Anything else, such as a bad token, a missing permission
 * or a 404, or an aborted request, comes back as it is.
 */
export function transientOrAsIs(error: unknown): unknown {
	if (!requestFailure(error) || error.name === 'AbortError') return error
	const rateLimited =
		error.status === tooManyRequests || (error.status === forbidden && error.response?.headers?.['retry-after'] !== undefined)
	return rateLimited || error.status >= firstServerError ? new HostToolTransientError(error.message, { cause: error }) : error
}

function requestFailure(error: unknown): error is RequestFailure {
	return error instanceof Error && 'status' in error && typeof error.status === 'number'
}
