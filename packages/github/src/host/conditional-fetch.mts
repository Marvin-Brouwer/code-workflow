import { createHash } from 'node:crypto'
import { unavailable } from './github-statuses.mts'

/** How much of GitHub's answers `conditionalFetch` keeps, the least recently used going first. */
export interface ConditionalFetchOptions {
	/** The most body text kept, counted in characters. */
	readonly maxCharacters: number
}

/** Room for every page a busy host looks at again and again, at tens of megabytes at most. */
export const defaultConditionalFetch: ConditionalFetchOptions = { maxCharacters: 16 * 1024 * 1024 }

/** GitHub's answer when what was asked for didn't change since the ETag it was sent. */
const notModified = 304

/** How many items GitHub puts on a page when the request doesn't say. */
const defaultPerPage = 30

/** Headers about how the body came over the wire, which no longer hold for a body that's kept as text. */
const transportHeaders = new Set(['content-encoding', 'content-length', 'transfer-encoding'])

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
 * token's rate limit, and the caller gets the kept answer as if it came again. Answers are kept in
 * memory per token and `Accept`, since GitHub's answer depends on both.
 *
 * A full page of a list is never kept: GitHub's ETag covers the body and not the `Link` header, so
 * a 304 would hide a next page that came since. A list read `since` a moment is kept like any read:
 * a watch asks with the same moment until something new comes. A `Request` object, a write, or a
 * read that brings its own `If-None-Match` is sent as it is.
 */
export function conditionalFetch(send: typeof fetch, options: ConditionalFetchOptions): typeof fetch {
	const kept = new Map<string, KeptAnswer>()
	let keptCharacters = 0
	const forget = (key: string) => {
		keptCharacters -= kept.get(key)?.body.length ?? 0
		kept.delete(key)
	}
	const keep = (key: string, answer: KeptAnswer) => {
		forget(key)
		kept.set(key, answer)
		keptCharacters += answer.body.length
		for (const oldest of kept.keys()) {
			if (keptCharacters <= options.maxCharacters) break
			forget(oldest)
		}
	}
	return async (input, init) => {
		const headers = new Headers(init?.headers)
		if (input instanceof Request || (init?.method ?? 'GET').toUpperCase() !== 'GET' || headers.has('if-none-match'))
			return send(input, init)
		const url = new URL(input instanceof URL ? input.href : input)
		const key = answerKey(headers, url)
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
		// GitHub being down for a moment says nothing about whether the kept answer still holds.
		if (unavailable(response.status)) return response
		const etag = response.headers.get('etag')
		if (!response.ok || etag === null) {
			forget(key)
			return response
		}
		const body = await response.text()
		const answerHeaders = [...response.headers].filter(([name]) => !transportHeaders.has(name))
		if (fullPage(url, body)) forget(key)
		else keep(key, { etag, status: response.status, headers: answerHeaders, body })
		return answeredFrom(
			response.url,
			new Response(body, { status: response.status, statusText: response.statusText, headers: answerHeaders }),
		)
	}
}

/** Whether `body` is a list with as many items as a page of `url` holds: more may have come on a next page. */
function fullPage(url: URL, body: string): boolean {
	const perPage = Number(url.searchParams.get('per_page') ?? defaultPerPage)
	try {
		const parsed: unknown = JSON.parse(body)
		return Array.isArray(parsed) && parsed.length >= perPage
	} catch {
		return false
	}
}

/** `response` as if it came from `url`: Octokit reads a response's URL, which a made response doesn't have. */
function answeredFrom(url: string, response: Response): Response {
	Object.defineProperty(response, 'url', { value: url })
	return response
}

/** Who asks for what, in which form: the token is hashed, so the kept answers don't hold it. */
function answerKey(headers: Headers, url: URL): string {
	const token = createHash('sha256')
		.update(headers.get('authorization') ?? '')
		.digest('hex')
	return `${token} ${headers.get('accept') ?? ''} ${url.href}`
}

/** The kept answer's headers, with what the 304 says now, such as the rate limit left, on top. */
function freshened(keptHeaders: readonly (readonly [string, string])[], now: Headers): Headers {
	const headers = new Headers(keptHeaders.map(([name, value]): [string, string] => [name, value]))
	for (const [name, value] of now) if (!transportHeaders.has(name)) headers.set(name, value)
	return headers
}
