import type { HostToolContext } from '@mesh-flow/gateway'
import { Octokit } from '@octokit/rest'
import { defaultFetchRetry, retryingFetch, type FetchRetryOptions } from './retrying-fetch.mts'
import { markedTransient } from './transient-error.mts'

/** The name of the GitHub token in the gateway's credential store: `mesh-flow credential set github/token`. */
export const tokenCredential = 'github/token'

/** How the host half reaches GitHub. */
export interface GithubApiOptions {
	/** The REST API's base URL. Default: GitHub's. */
	readonly apiUrl?: string
	/** Sends the requests. Default: the global `fetch`. */
	readonly fetch?: typeof fetch
	/** How a request that GitHub didn't answer is tried again. Default: {@link defaultFetchRetry}. */
	readonly retry?: FetchRetryOptions
}

/** The most items GitHub hands back on one page of a list. */
export const pageSize = 100

/** A client for one call, with the token from the credential store and the call's signal. */
export type ApiClient = (context: HostToolContext) => Promise<Octokit>

/** GitHub's REST API, where host tools go when no `apiUrl` is given. */
export const defaultApiUrl = 'https://api.github.com'

/** The token from the call's credential store, or an error saying how to set it. */
export async function requireToken({ credentials, abortSignal }: HostToolContext): Promise<string> {
	const token = await credentials.get(tokenCredential, abortSignal)
	if (token === undefined) throw new Error(`There is no GitHub token. Set it with \`mesh-flow credential set ${tokenCredential}\`.`)
	return token
}

/**
 * Opens GitHub's REST API for host tools: every call takes the token from the credential store, so
 * a new token counts at once. Reads are tried again when the connection drops or GitHub is briefly
 * unavailable (see {@link retryingFetch}), and a failure that may still pass after that is thrown
 * as transient, so a watch looks again later instead of failing.
 */
export function githubApi(options: GithubApiOptions = {}): ApiClient {
	const send = retryingFetch(options.fetch ?? fetch, options.retry ?? defaultFetchRetry)
	return async (context) => {
		const octokit = new Octokit({
			auth: await requireToken(context),
			baseUrl: options.apiUrl ?? defaultApiUrl,
			request: { signal: context.abortSignal, fetch: send },
		})
		octokit.hook.error('request', (error) => {
			throw markedTransient(error)
		})
		return octokit
	}
}
