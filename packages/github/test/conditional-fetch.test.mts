import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { conditionalFetch, type ConditionalFetchOptions } from '../src/host/conditional-fetch.mts'

/** A read of one pull request. */
const url = 'https://api.github.example/repos/team/app/pulls/3'

/** Room for every answer a test keeps. */
const keepMany: ConditionalFetchOptions = { maxCharacters: 10_000 }

/** How soon a read that stopped has to settle. */
const promptlyMs = 1000

/** When the abort test stops its read. */
const abortAfterMs = 10

/** Request options that send `token`, which answers are kept per. */
const askedWith = (token: string) => ({ headers: { authorization: `token ${token}` } })

/** GitHub answering with `etag`, or 304 when it was sent that ETag. */
function githubWithEtag(etag: string, body: string) {
	return vi.fn<typeof fetch>(async (_input, init) =>
		new Headers(init?.headers).get('if-none-match') === etag
			? new Response(null, { status: 304, headers: { etag, 'x-ratelimit-remaining': '4999' } })
			: new Response(body, { status: 200, headers: { etag, 'content-type': 'application/json', 'x-ratelimit-remaining': '4998' } }),
	)
}

/** How each request was asked: with which ETag, if any. */
const etagsSent = (github: ReturnType<typeof vi.fn<typeof fetch>>) =>
	github.mock.calls.map(([, init]) => new Headers(init?.headers).get('if-none-match'))

describe('conditionalFetch', () => {
	test('asks again with the ETag, and hands the kept answer back when GitHub says nothing changed', async () => {
		// Arrange
		const github = githubWithEtag('"v1"', '{"number":3}')
		const send = conditionalFetch(github, keepMany)

		// Act
		await (await send(url, askedWith('a'))).text()
		const again = await send(url, askedWith('a'))

		// Assert
		expect(etagsSent(github)).toEqual([null, '"v1"'])
		expect(again.status).toBe(200)
		expect(await again.json()).toEqual({ number: 3 })
		expect(again.headers.get('content-type')).toBe('application/json')
		expect(again.headers.get('x-ratelimit-remaining')).toBe('4999')
	})

	test('keeps answers per token', async () => {
		// Arrange
		const github = githubWithEtag('"v1"', '{}')
		const send = conditionalFetch(github, keepMany)

		// Act
		await send(url, askedWith('a'))
		await send(url, askedWith('b'))

		// Assert
		expect(etagsSent(github)).toEqual([null, null])
	})

	test('sends writes and Request objects as they are', async () => {
		// Arrange
		const github = githubWithEtag('"v1"', '{}')
		const send = conditionalFetch(github, keepMany)
		await send(url, askedWith('a'))

		// Act
		await send(url, { ...askedWith('a'), method: 'PATCH', body: '{}' })
		await send(new Request(url, askedWith('a')))

		// Assert
		expect(etagsSent(github)).toEqual([null, null, null])
	})

	test('keeps nothing from an answer without an ETag', async () => {
		// Arrange
		const github = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
		const send = conditionalFetch(github, keepMany)

		// Act
		await send(url, askedWith('a'))
		await send(url, askedWith('a'))

		// Assert
		expect(etagsSent(github)).toEqual([null, null])
	})

	test('never keeps a full page of a list, where a next page may have come since', async () => {
		// Arrange
		const fullPage = githubWithEtag('"v1"', '[1,2]')
		const shortPage = githubWithEtag('"v1"', '[1]')
		const sendFull = conditionalFetch(fullPage, keepMany)
		const sendShort = conditionalFetch(shortPage, keepMany)
		const pageOfTwo = `${url}/comments?per_page=2`

		// Act
		await sendFull(pageOfTwo, askedWith('a'))
		await sendFull(pageOfTwo, askedWith('a'))
		await sendShort(pageOfTwo, askedWith('a'))
		await sendShort(pageOfTwo, askedWith('a'))

		// Assert
		expect(etagsSent(fullPage)).toEqual([null, null])
		expect(etagsSent(shortPage)).toEqual([null, '"v1"'])
	})

	test('keeps the answer through a moment GitHub is unavailable', async () => {
		// Arrange
		const github = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { etag: '"v1"' } }))
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"v1"' } }))
		const send = conditionalFetch(github, keepMany)

		// Act
		await send(url, askedWith('a'))
		const unavailable = await send(url, askedWith('a'))
		const again = await send(url, askedWith('a'))

		// Assert
		expect(unavailable.status).toBe(503)
		expect(etagsSent(github)).toEqual([null, '"v1"', '"v1"'])
		expect(await again.text()).toBe('{}')
	})

	test('hands back no wire headers for a body it made', async () => {
		// Arrange
		const wire = { etag: '"v1"', 'content-encoding': 'gzip', 'content-length': '20' }
		const github = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 200, headers: wire }))
			.mockResolvedValueOnce(new Response(null, { status: 304, headers: wire }))
		const send = conditionalFetch(github, keepMany)

		// Act
		const first = await send(url, askedWith('a'))
		const again = await send(url, askedWith('a'))

		// Assert
		expect([first.headers.get('content-encoding'), first.headers.get('content-length')]).toEqual([null, null])
		expect([again.headers.get('content-encoding'), again.headers.get('content-length')]).toEqual([null, null])
	})

	test('settles promptly when the request is aborted while GitHub never answers', async () => {
		// Arrange
		const controller = new AbortController()
		const github = vi.fn<typeof fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason)
					})
				}),
		)
		const started = performance.now()

		// Act
		const sent = conditionalFetch(github, keepMany)(url, { ...askedWith('a'), signal: controller.signal })
		const timer = setTimeout(() => {
			controller.abort(new Error('The run stopped.'))
		}, abortAfterMs)
		onTestFinished(() => {
			clearTimeout(timer)
		})

		// Assert
		await expect(sent).rejects.toThrow('The run stopped.')
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})
})
