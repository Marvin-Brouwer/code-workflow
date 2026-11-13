import {
	defaultFetchRetry,
	goneStatus,
	notFound,
	retryingFetch,
	unauthorized,
	unavailable,
	type FetchRetryOptions,
} from '@mesh-flow/forge/host'
import { HostToolTransientError, type HostToolContext } from '@mesh-flow/gateway'
import { z } from 'zod'
import { readSite } from './site.mts'

/** How the host half reaches GitLab. */
export interface GitlabApiOptions {
	/** Sends the requests. Default: the global `fetch`. */
	readonly fetch?: typeof fetch
	/** How a read that GitLab didn't answer is tried again. Default: {@link defaultFetchRetry}. */
	readonly retry?: FetchRetryOptions
}

/** The most items GitLab hands back on one page of a list. */
const pageSize = 100

/** What a request to GitLab's REST API sends besides its method and path. */
export interface RequestOptions {
	readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
	readonly body?: unknown
}

/** GitLab's REST API (`/api/v4`) for one host call, with its token and its signal. */
export interface GitlabClient {
	/** The GitLab's base URL, such as `https://gitlab.com`. */
	readonly url: string
	/** Sends a request and parses the answer with `schema`. */
	request<Schema extends z.ZodType>(method: string, path: string, schema: Schema, options?: RequestOptions): Promise<z.output<Schema>>
	/** Reads every page of a list, each item parsed with `item`. */
	all<Schema extends z.ZodType>(path: string, item: Schema, query?: RequestOptions['query']): Promise<z.output<Schema>[]>
	/** Reads the first page of a list, of `size` items at most, and whether there are more. */
	firstPage<Schema extends z.ZodType>(
		path: string,
		item: Schema,
		size: number,
		query?: RequestOptions['query'],
	): Promise<{ items: z.output<Schema>[]; more: boolean }>
	/** Sends a request whose answer has no body worth reading, such as a delete. */
	send(method: string, path: string, options?: RequestOptions): Promise<void>
}

/** A client for one call. */
export type ApiClient = (context: HostToolContext) => Promise<GitlabClient>

/** GitLab's answer to a request that wasn't served, with its status, so a caller can tell a 404 from the rest. */
export class GitlabRequestError extends Error {
	override readonly name = 'GitlabRequestError'
	readonly status: number

	constructor(message: string, status: number) {
		super(message)
		this.status = status
	}
}

/** A project's path as it goes in a URL: GitLab takes `group/project` encoded as one segment. */
export function projectSegment(project: string): string {
	return `/projects/${encodeURIComponent(project)}`
}

/**
 * Opens GitLab's REST API for host tools: every call reads the URL and the token from the
 * credential store, so a new token counts at once. Reads are tried again when the connection drops
 * or GitLab is briefly unavailable (see {@link retryingFetch}), and a failure that may still pass
 * after that is thrown as transient, so a watch looks again later instead of failing.
 */
export function gitlabApi(options: GitlabApiOptions = {}): ApiClient {
	const send = retryingFetch(options.fetch ?? fetch, options.retry ?? defaultFetchRetry)
	return async (context) => {
		const site = await readSite(context)
		const base = `${site.url}/api/v4`
		const call = async (method: string, path: string, { query, body }: RequestOptions = {}): Promise<Response> => {
			const url = new URL(`${base}${path}`)
			for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value))
			let response: Response
			try {
				response = await send(url, {
					method,
					headers: {
						authorization: `Bearer ${site.token}`,
						accept: 'application/json',
						...(body === undefined ? {} : { 'content-type': 'application/json' }),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: context.abortSignal,
				})
			} catch (error) {
				if (context.abortSignal.aborted) throw error
				throw new HostToolTransientError(`GitLab didn't answer ${method} ${path}.`, { cause: error })
			}
			if (response.ok) return response
			const message = `GitLab answered ${String(response.status)} to ${method} ${path}: ${await failureText(response)}`
			if (unavailable(response.status)) throw new HostToolTransientError(message)
			throw new GitlabRequestError(message, response.status)
		}
		return Object.freeze<GitlabClient>({
			url: site.url,
			async request(method, path, schema, requestOptions) {
				const response = await call(method, path, requestOptions)
				return schema.parse(await response.json())
			},
			async all(path, item, query = {}) {
				const items: z.output<typeof item>[] = []
				for (let page: string | null = '1'; page !== null && page !== '';) {
					const response = await call('GET', path, { query: { ...query, per_page: pageSize, page } })
					items.push(...(await listOf(response, path)).map((entry) => item.parse(entry)))
					page = response.headers.get('x-next-page')
				}
				return items
			},
			async firstPage(path, item, size, query = {}) {
				const response = await call('GET', path, { query: { ...query, per_page: size, page: 1 } })
				const items = (await listOf(response, path)).map((entry) => item.parse(entry))
				return { items, more: (response.headers.get('x-next-page') ?? '') !== '' }
			},
			async send(method, path, requestOptions) {
				const response = await call(method, path, requestOptions)
				await response.body?.cancel()
			},
		})
	}
}

/** The entries of a list GitLab answered with. */
async function listOf(response: Response, path: string): Promise<unknown[]> {
	const listed = z.array(z.unknown()).safeParse(await response.json())
	if (!listed.success) throw new Error(`GitLab answered GET ${path} with something that isn't a list.`)
	return listed.data
}

/** The most of a failure's body that goes into its error, such as a proxy's whole error page. */
const maxFailureTextCharacters = 500

/** What GitLab said about a failure: its `message` or `error`, or the body as it is. */
async function failureText(response: Response): Promise<string> {
	const text = await response.text()
	try {
		const parsed: unknown = JSON.parse(text)
		if (typeof parsed === 'object' && parsed !== null) {
			const said: unknown = Reflect.get(parsed, 'message') ?? Reflect.get(parsed, 'error')
			if (said !== undefined) return typeof said === 'string' ? said : JSON.stringify(said)
		}
	} catch {
		// Not JSON, such as a proxy's error page: the text says what there is to say.
	}
	return text.slice(0, maxFailureTextCharacters)
}

/** Whether GitLab answered that what was asked for is gone, such as a note deleted since. */
export function isGone(error: unknown): boolean {
	return error instanceof GitlabRequestError && (error.status === notFound || error.status === goneStatus)
}

/** Whether GitLab refused the token: one that's wrong, expired or revoked. */
export function refusedToken(error: unknown): boolean {
	return error instanceof GitlabRequestError && error.status === unauthorized
}
