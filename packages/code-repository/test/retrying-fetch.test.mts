import { createServer } from 'node:http'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { retryingFetch, type FetchRetryOptions } from '../src/host/retrying-fetch.mts'

const url = 'https://api.github.example/repos/team/app'
/** Host retries that are over in a moment. */
const quickRetry: FetchRetryOptions = { attempts: 3, firstDelayMs: 1, longestRetryAfterMs: 1000, attemptTimeoutMs: 1000 }

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

	test.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
		'sends a %s once, since a dropped write may have reached GitHub all the same',
		async (method) => {
			// Arrange
			const send = vi.fn<typeof fetch>(async () => {
				throw dropped()
			})

			// Act
			const sent = retryingFetch(send, quickRetry)(url, { method, body: '{"body":"On it."}' })

			// Assert
			await expect(sent).rejects.toThrow('fetch failed')
			expect(send).toHaveBeenCalledTimes(1)
		},
	)

	test('sends a Request object once, since its body may be used up', async () => {
		// Arrange
		const send = vi.fn<typeof fetch>(async () => answer(503))

		// Act
		const response = await retryingFetch(send, quickRetry)(new Request(url, { method: 'POST', body: '{}' }))

		// Assert
		expect(response.status).toBe(503)
		expect(send).toHaveBeenCalledTimes(1)
	})

	test('counts an attempt that gets no answer as dropped, and sends it again', async () => {
		// Arrange
		const send = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => {
							reject(init.signal?.reason)
						})
					}),
			)
			.mockResolvedValueOnce(answer(200))

		// Act
		const response = await retryingFetch(send, { ...quickRetry, attemptTimeoutMs: 10 })(url)

		// Assert
		expect(response.status).toBe(200)
		expect(send).toHaveBeenCalledTimes(2)
	})

	test('times only the wait for the answer, so a slow body is read to the end', async () => {
		// Arrange
		// Room for the headers to come back on a busy CI runner, and a body that takes far longer than that.
		const answerTimeoutMs = 200
		const bodyDelayMs = 5 * answerTimeoutMs
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.flushHeaders()
			setTimeout(() => {
				response.end('{"login":"mesh-flow-bot"}')
			}, bodyDelayMs)
		})
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve)
		})
		onTestFinished(() => {
			server.closeAllConnections()
			server.close()
		})
		const address = server.address()
		if (address === null || typeof address === 'string') throw new Error('The server has no port.')

		// Act
		const response = await retryingFetch(fetch, { ...quickRetry, attemptTimeoutMs: answerTimeoutMs })(
			`http://127.0.0.1:${String(address.port)}/user`,
		)
		const body: unknown = await response.json()

		// Assert
		expect(body).toEqual({ login: 'mesh-flow-bot' })
	})

	test('cancels the body of an unavailable answer before it waits out its retry-after', async () => {
		// Arrange
		const unavailable = answer(503, { 'retry-after': '0' })
		const send = vi.fn<typeof fetch>().mockResolvedValueOnce(unavailable).mockResolvedValueOnce(answer(200))

		// Act
		const response = await retryingFetch(send, quickRetry)(url)

		// Assert
		expect(response.status).toBe(200)
		await expect(unavailable.text()).rejects.toThrow()
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
