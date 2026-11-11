import { describe, expect, test } from 'vitest'
import { transientOrAsIs } from '../src/host/transient-error.mts'

/** An error shaped like Octokit's `RequestError`. */
function requestError(status: number, headers: Record<string, string> = {}, name = 'HttpError') {
	return Object.assign(new Error(`GitHub answered ${String(status)}`), { name, status, response: { headers } })
}

describe('transientOrAsIs', () => {
	test.each([
		['a dropped connection, which Octokit reports as 500', requestError(500)],
		['GitHub being unavailable', requestError(503)],
		['a rate limit', requestError(429)],
		['a secondary rate limit', requestError(403, { 'retry-after': '60' })],
	])('marks %s as transient, keeping the message', (_case, error) => {
		// Act
		const marked = transientOrAsIs(error)

		// Assert
		expect(marked).toMatchObject({ name: 'HostToolTransientError', transient: true, message: error.message, cause: error })
	})

	test.each([
		['a bad token', requestError(401)],
		['a missing permission', requestError(403)],
		['something that is gone', requestError(404)],
		['an aborted request', requestError(500, {}, 'AbortError')],
		['an error without a status', new Error('There is no GitHub token.')],
	])('leaves %s as it is', (_case, error) => {
		// Act
		const marked = transientOrAsIs(error)

		// Assert
		expect(marked).toBe(error)
	})
})
