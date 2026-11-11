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
		['a primary rate limit', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' }],
	])('marks %s as transient, keeping the message', (_case, status, headers) => {
		// Arrange
		const error = requestError(status, headers)

		// Act
		const marked = markedTransient(error)

		// Assert
		expect(marked).toMatchObject({ name: 'HostToolTransientError', transient: true, message: error.message, cause: error })
	})

	test.each([
		['a bad token', 401, 'HttpError'],
		['a missing permission', 403, 'HttpError'],
		['something that is gone', 404, 'HttpError'],
		['an aborted request', 500, 'AbortError'],
	])('leaves %s as it is', (_case, status, name) => {
		// Arrange
		const error = requestError(status, {}, name)

		// Act
		const marked = markedTransient(error)

		// Assert
		expect(marked).toBe(error)
	})

	test('leaves an error without a status as it is', () => {
		// Arrange
		const error = new Error('There is no GitHub token.')

		// Act
		const marked = markedTransient(error)

		// Assert
		expect(marked).toBe(error)
	})
})
