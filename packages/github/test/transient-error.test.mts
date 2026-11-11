import { describe, expect, test } from 'vitest'
import { markedTransient } from '../src/host/transient-error.mts'

/** An error shaped like Octokit's `RequestError`. */
function requestError(status: number, headers: Record<string, string> = {}, name = 'HttpError') {
	return Object.assign(new Error(`GitHub answered ${String(status)}`), { name, status, response: { headers } })
}

describe('markedTransient', () => {
	test.each([
		['a dropped connection, which Octokit reports as 500', 500, {}],
		['GitHub being unavailable', 503, {}],
		['a rate limit', 429, {}],
		['a secondary rate limit', 403, { 'retry-after': '60' }],
	])('marks %s as transient, keeping the message', (_case, status, headers) => {
		// Arrange
		const error = requestError(status, headers)

		// Act
		const marked = markedTransient(error)

		// Assert
		expect(marked).toMatchObject({ name: 'HostToolTransientError', transient: true, message: error.message, cause: error })
	})

	test.each([
		['a bad token', requestError(401)],
		['a missing permission', requestError(403)],
		['something that is gone', requestError(404)],
		['an aborted request', requestError(500, {}, 'AbortError')],
		['an error without a status', new Error('There is no GitHub token.')],
	])('leaves %s as it is', (_case, failure) => {
		// Arrange
		const error: Error = failure

		// Act
		const marked = markedTransient(error)

		// Assert
		expect(marked).toBe(error)
	})
})
