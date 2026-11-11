import { describe, expect, test, vi } from 'vitest'
import { conditionalFetch, type ConditionalFetchOptions } from '../src/host/conditional-fetch.mts'

const url = 'https://api.github.example/repos/team/app/pulls/3'
const keepMany: ConditionalFetchOptions = { maxAnswers: 100 }
const asking = (token: string) => ({ headers: { authorization: `token ${token}` } })

/** GitHub answering with `etag`, or 304 when it was sent that ETag. */
function githubWithEtag(etag: string, body: string) {
	return vi.fn<typeof fetch>(async (_input, init) =>
		new Headers(init?.headers).get('if-none-match') === etag
			? new Response(null, { status: 304, headers: { etag, 'x-ratelimit-remaining': '4999' } })
			: new Response(body, { status: 200, headers: { etag, 'content-type': 'application/json', 'x-ratelimit-remaining': '4998' } }),
	)
}

/** How each request was asked: with which ETag, if any. */
const etagsSent = (send: ReturnType<typeof vi.fn<typeof fetch>>) =>
	send.mock.calls.map(([, init]) => new Headers(init?.headers).get('if-none-match'))

describe('conditionalFetch', () => {
	test('asks again with the ETag, and hands the kept answer back when GitHub says nothing changed', async () => {
		// Arrange
		const send = githubWithEtag('"v1"', '{"number":3}')
		const read = conditionalFetch(send, keepMany)

		// Act
		await (await read(url, asking('a'))).text()
		const again = await read(url, asking('a'))

		// Assert
		expect(etagsSent(send)).toEqual([null, '"v1"'])
		expect(again.status).toBe(200)
		expect(await again.json()).toEqual({ number: 3 })
		expect(again.headers.get('content-type')).toBe('application/json')
		expect(again.headers.get('x-ratelimit-remaining')).toBe('4999')
	})

	test('keeps answers per token, and leaves writes, Request objects and answers without an ETag alone', async () => {
		// Arrange
		const send = githubWithEtag('"v1"', '{}')
		const read = conditionalFetch(send, keepMany)
		const withoutEtag = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
		const readWithoutEtag = conditionalFetch(withoutEtag, keepMany)

		// Act
		await read(url, asking('a'))
		await read(url, asking('b'))
		await read(url, { ...asking('a'), method: 'PATCH', body: '{}' })
		await read(new Request(url, asking('a')))
		await readWithoutEtag(url, asking('a'))
		await readWithoutEtag(url, asking('a'))

		// Assert
		expect(etagsSent(send)).toEqual([null, null, null, null])
		expect(etagsSent(withoutEtag)).toEqual([null, null])
	})

	test('forgets the least recently used answer once it keeps as many as it may', async () => {
		// Arrange
		const send = githubWithEtag('"v1"', '{}')
		const read = conditionalFetch(send, { maxAnswers: 1 })

		// Act
		await read(`${url}/a`, asking('a'))
		await read(`${url}/b`, asking('a'))
		await read(`${url}/a`, asking('a'))

		// Assert
		expect(etagsSent(send)).toEqual([null, null, null])
	})

	test('settles promptly when the request is aborted while GitHub never answers', async () => {
		// Arrange
		const controller = new AbortController()
		const send = vi.fn<typeof fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason)
					})
				}),
		)
		const started = performance.now()

		// Act
		const sent = conditionalFetch(send, keepMany)(url, { ...asking('a'), signal: controller.signal })
		setTimeout(() => {
			controller.abort(new Error('The run stopped.'))
		}, 10)

		// Assert
		await expect(sent).rejects.toThrow('The run stopped.')
		expect(performance.now() - started).toBeLessThan(1000)
	})
})
