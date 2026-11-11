import { describe, expect, test, vi } from 'vitest'
import { retryingFetch, type FetchRetryOptions } from '../src/host/retrying-fetch.mts'

const url = 'https://api.github.example/repos/team/app'
/** Host retries that are over in a moment. */
const quickRetry: FetchRetryOptions = { attempts: 3, firstDelayMs: 1, longestRetryAfterMs: 1000 }

/** A GitHub response with `status`. */
const answer = (status: number, headers: Record<string, string> = {}) => new Response(status === 204 ? null : '{}', { status, headers })
/** The error `fetch` throws when the connection drops. */
const dropped = () => new TypeError('fetch failed', { cause: new Error('write ECONNABORTED') })

describe('retryingFetch', () => {
	test('sends a read again after a dropped connection and an unavailable GitHub, and returns the answer that came through', async () => {
		// Arrange
		const send = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(dropped())
			.mockResolvedValueOnce(answer(503))
			.mockResolvedValueOnce(answer(200))

		// Act
		const response = await retryingFetch(send, quickRetry)(url, { method: 'GET' })

		// Assert
		expect(response.status).toBe(200)
		expect(send).toHaveBeenCalledTimes(3)
	})

	test('hands back the last answer or error once the attempts are used up', async () => {
		// Arrange
		const unavailable = vi.fn<typeof fetch>(async () => answer(502))
		const unreachable = vi.fn<typeof fetch>(async () => {
			throw dropped()
		})

		// Act
		const response = await retryingFetch(unavailable, quickRetry)(url)
		const failed = retryingFetch(unreachable, quickRetry)(url)

		// Assert
		expect(response.status).toBe(502)
		expect(unavailable).toHaveBeenCalledTimes(3)
		await expect(failed).rejects.toThrow('fetch failed')
		expect(unreachable).toHaveBeenCalledTimes(3)
	})

	test('sends a POST once, since a dropped one may have reached GitHub all the same', async () => {
		// Arrange
		const send = vi.fn<typeof fetch>(async () => {
			throw dropped()
		})

		// Act
		const sent = retryingFetch(send, quickRetry)(url, { method: 'POST', body: '{"body":"On it."}' })

		// Assert
		await expect(sent).rejects.toThrow('fetch failed')
		expect(send).toHaveBeenCalledTimes(1)
	})

	test('leaves an answer that says the request was wrong alone', async () => {
		// Arrange
		const send = vi.fn<typeof fetch>(async () => answer(404))

		// Act
		const response = await retryingFetch(send, quickRetry)(url)

		// Assert
		expect(response.status).toBe(404)
		expect(send).toHaveBeenCalledTimes(1)
	})

	test('waits out a short retry-after on a rate limit, and hands a longer one back to the caller', async () => {
		// Arrange
		const short = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(answer(429, { 'retry-after': '0' }))
			.mockResolvedValueOnce(answer(200))
		const long = vi.fn<typeof fetch>(async () => answer(429, { 'retry-after': '3600' }))

		// Act
		const waited = await retryingFetch(short, quickRetry)(url)
		const handedBack = await retryingFetch(long, quickRetry)(url)

		// Assert
		expect(waited.status).toBe(200)
		expect(short).toHaveBeenCalledTimes(2)
		expect(handedBack.status).toBe(429)
		expect(long).toHaveBeenCalledTimes(1)
	})

	test('stops waiting for the next attempt as soon as the request is aborted', async () => {
		// Arrange
		const controller = new AbortController()
		const send = vi.fn<typeof fetch>(async () => {
			controller.abort(new Error('The run stopped.'))
			throw dropped()
		})
		const started = performance.now()

		// Act
		const sent = retryingFetch(send, { ...quickRetry, firstDelayMs: 60_000 })(url, { signal: controller.signal })

		// Assert
		await expect(sent).rejects.toThrow('fetch failed')
		expect(send).toHaveBeenCalledTimes(1)
		expect(performance.now() - started).toBeLessThan(1000)
	})

	test('settles promptly when aborted while it waits between attempts', async () => {
		// Arrange
		const controller = new AbortController()
		const send = vi.fn<typeof fetch>(async () => answer(503))
		const started = performance.now()

		// Act
		const sent = retryingFetch(send, { ...quickRetry, firstDelayMs: 60_000 })(url, { signal: controller.signal })
		setTimeout(() => {
			controller.abort(new Error('The run stopped.'))
		}, 10)

		// Assert
		await expect(sent).rejects.toMatchObject({ name: 'AbortError' })
		expect(send).toHaveBeenCalledTimes(1)
		expect(performance.now() - started).toBeLessThan(1000)
	})
})
