import { createHash } from 'node:crypto'

/** How many answers `conditionalFetch` keeps, the least recently used going first. */
export interface ConditionalFetchOptions {
	readonly maxAnswers: number
}

/** Enough for every page a busy host looks at again and again, at a few megabytes at most. */
export const defaultConditionalFetch: ConditionalFetchOptions = { maxAnswers: 1000 }

/** GitHub's answer when what was asked for didn't change since the ETag it was sent. */
const notModified = 304

/** What is kept of an answer to a read: its ETag, to ask with next time, and what to hand back when it didn't change. */
interface KeptAnswer {
	readonly etag: string
	readonly status: number
	readonly headers: readonly (readonly [string, string])[]
	readonly body: string
}

/**
 * Wraps `send` so that a read GitHub answered with an ETag is asked for next time with that ETag
 * (`If-None-Match`). When nothing changed GitHub answers 304, which doesn't count against the
 * token's rate limit, and the caller gets the kept answer as if it came again. Answers are kept per
 * token, since GitHub's answer depends on who asks, in memory only. A `Request` object, a write, or
 * a read that brings its own `If-None-Match` is sent as it is.
 */
export function conditionalFetch(send: typeof fetch, options: ConditionalFetchOptions): typeof fetch {
	const kept = new Map<string, KeptAnswer>()
	const keep = (key: string, answer: KeptAnswer) => {
		kept.delete(key)
		kept.set(key, answer)
		for (const oldest of kept.keys()) {
			if (kept.size <= options.maxAnswers) break
			kept.delete(oldest)
		}
	}
	return async (input, init) => {
		const headers = new Headers(init?.headers)
		if (input instanceof Request || (init?.method ?? 'GET').toUpperCase() !== 'GET' || headers.has('if-none-match'))
			return send(input, init)
		const key = answerKey(headers.get('authorization'), input instanceof URL ? input.href : input)
		const known = kept.get(key)
		if (known !== undefined) headers.set('if-none-match', known.etag)
		const response = await send(input, { ...init, headers })
		if (known !== undefined && response.status === notModified) {
			await response.body?.cancel()
			keep(key, known)
			return answeredFrom(
				response.url,
				new Response(known.body, { status: known.status, headers: freshened(known.headers, response.headers) }),
			)
		}
		const etag = response.headers.get('etag')
		if (!response.ok || etag === null) {
			kept.delete(key)
			return response
		}
		const body = await response.text()
		keep(key, { etag, status: response.status, headers: [...response.headers], body })
		return answeredFrom(
			response.url,
			new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
		)
	}
}

/** `response` as if it came from `url`: Octokit reads a response's URL, which a made response doesn't have. */
function answeredFrom(url: string, response: Response): Response {
	Object.defineProperty(response, 'url', { value: url })
	return response
}

/** Who asks for what: the token is hashed, so the kept answers don't hold it. */
function answerKey(authorization: string | null, url: string): string {
	return `${createHash('sha256')
		.update(authorization ?? '')
		.digest('hex')} ${url}`
}

/** The kept answer's headers, with what the 304 says now, such as the rate limit left, on top. */
function freshened(keptHeaders: readonly (readonly [string, string])[], now: Headers): Headers {
	const headers = new Headers(keptHeaders.map(([name, value]): [string, string] => [name, value]))
	for (const [name, value] of now) if (name !== 'content-length') headers.set(name, value)
	return headers
}
