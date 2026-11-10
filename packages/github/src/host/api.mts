import type { HostToolContext } from '@mesh-flow/gateway'
import { Octokit } from '@octokit/rest'

/** The name of the GitHub token in the gateway's credential store: `mesh-flow credential set github/token`. */
export const tokenCredential = 'github/token'

/** How the host half reaches GitHub. */
export interface GithubApiOptions {
	/** The REST API's base URL. Default: GitHub's. */
	readonly apiUrl?: string
	/** Sends the requests. Default: the global `fetch`. */
	readonly fetch?: typeof fetch
}

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

/** Opens GitHub's REST API for host tools: every call takes the token from the credential store, so a new token counts at once. */
export function githubApi(options: GithubApiOptions = {}): ApiClient {
	return async (context) =>
		new Octokit({
			auth: await requireToken(context),
			baseUrl: options.apiUrl ?? defaultApiUrl,
			request: { signal: context.abortSignal, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) },
		})
}
