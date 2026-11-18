import { createServer } from 'node:http'
import { duration } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { retryingFetch, type FetchResends, type FetchRetryOptions } from '../src/http/retrying-fetch.mts'

const url = 'https://api.example.com/items/1'
/** Host retries that are over in a moment. */
const quickRetry: FetchRetryOptions = {
	waits: [duration.of('1ms'), duration.of('1ms')],
	longestRetryAfter: duration.of('1s'),
	attemptTimeout: duration.of('1s'),
}

/** Waits between attempts far longer than a test runs. */
const longWaits = [duration.of('1m'), duration.of('1m')]

/** A response with `status`. */
const answer = (status: number, headers: Record<string, string> = {}) => new Response(status === 204 ? null : '{}', { status, headers })
/** A service whose updates may be sent twice. */
const putsToo: FetchResends = ({ method }) => method === 'PUT'

/** The error `fetch` throws when the connection drops. */
const dropped = () => new TypeError('fetch failed', { cause: new Error('write ECONNABORTED') })

describe('retryingFetch', () => {
	test('sends a read again after a dropped connection and an unavailable service, and returns the answer that came through', async () => {
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
		'sends a %s once, since a dropped write may have reached the service all the same',
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

	test('sends a write again that the service says may be sent twice', async () => {
		// Arrange
		const send = vi.fn<typeof fetch>().mockResolvedValueOnce(answer(503)).mockResolvedValue(answer(200))

		// Act
		const response = await retryingFetch(send, quickRetry, putsToo)(url, { method: 'PUT', body: '{"value":1}' })

		// Assert
		expect(response.status).toBe(200)
		expect(send).toHaveBeenCalledTimes(2)
	})

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
		const response = await retryingFetch(send, { ...quickRetry, attemptTimeout: duration.of('10ms') })(url)

		// Assert
		expect(response.status).toBe(200)
		expect(send).toHaveBeenCalledTimes(2)
	})

	test('fails a read that never got an answer as fetch does when its wait for the headers runs out', async () => {
		// Arrange
		const send = vi.fn<typeof fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason)
					})
				}),
		)

		// Act
		const failed = retryingFetch(send, { ...quickRetry, attemptTimeout: duration.of('1ms') })(url)

		// Assert
		await expect(failed).rejects.toThrow(TypeError)
		await expect(failed).rejects.toMatchObject({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
		expect(send).toHaveBeenCalledTimes(quickRetry.waits.length + 1)
	})

	test('times only the wait for the answer, so a slow body is read to the end', async () => {
		// Arrange
		// Room for the headers to come back on a busy CI runner, and a body that takes far longer than that.
		const answerTimeout = duration.of('200ms')
		const bodyDelay = duration.of('1s')
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.flushHeaders()
			setTimeout(() => {
				response.end('{"login":"mesh-flow-bot"}')
			}, bodyDelay.to('ms'))
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
		const response = await retryingFetch(fetch, { ...quickRetry, attemptTimeout: answerTimeout })(
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

	test('reads a retry-after that is a date, and hands a far one back to the caller', async () => {
		// Arrange
		const past = new Date(0).toUTCString()
		const later = duration.of('1h').after(new Date()).toUTCString()
		const short = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(answer(503, { 'retry-after': past }))
			.mockResolvedValueOnce(answer(200))
		const long = vi.fn<typeof fetch>(async () => answer(503, { 'retry-after': later }))

		// Act
		const waited = await retryingFetch(short, quickRetry)(url)
		const handedBack = await retryingFetch(long, quickRetry)(url)

		// Assert
		expect(waited.status).toBe(200)
		expect(handedBack.status).toBe(503)
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
		const sent = retryingFetch(send, { ...quickRetry, waits: longWaits })(url, { signal: controller.signal })

		// Assert
		await expect(sent).rejects.toThrow('fetch failed')
		expect(send).toHaveBeenCalledTimes(1)
		expect(performance.now() - started).toBeLessThan(duration.of('1s').to('ms'))
	})

	test('settles promptly when aborted while it waits between attempts', async () => {
		// Arrange
		const controller = new AbortController()
		const send = vi.fn<typeof fetch>(async () => answer(503))
		const started = performance.now()

		// Act
		const sent = retryingFetch(send, { ...quickRetry, waits: longWaits })(url, { signal: controller.signal })
		setTimeout(() => {
			controller.abort(new Error('The run stopped.'))
		}, duration.of('10ms').to('ms'))

		// Assert
		await expect(sent).rejects.toThrow('The run stopped.')
		expect(send).toHaveBeenCalledTimes(1)
		expect(performance.now() - started).toBeLessThan(duration.of('1s').to('ms'))
	})
})
