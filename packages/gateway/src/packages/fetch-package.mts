import type { PackageRequest, PackageResponse } from '@mesh-flow/protocol'
import { defaultFetchRetry, retryingFetch } from '../http/retrying-fetch.mts'
import { publicRegistries } from './public-registries.mts'

/** The headers of a registry's answer that a package manager uses: what the body is, and what version of it. */
const keptHeaders = ['content-type', 'etag', 'last-modified']

/**
 * Fetches a package or its metadata from a public registry, for a package manager in a sandbox that
 * has no network. Only reads: a path the registry doesn't serve packages on, or one that isn't
 * already normalized (`..`, `//`), is turned down before anything is sent. Whatever the registry
 * answers is the answer, a 404 too; package managers ask for what may not exist.
 *
 * @throws When the path isn't a package fetch on that registry.
 */
export async function fetchPackage(request: PackageRequest, send: typeof fetch, abortSignal: AbortSignal): Promise<PackageResponse> {
	const registry = publicRegistries[request.registry]
	const url = new URL(request.path, registry.origin)
	if (url.origin !== registry.origin || `${url.pathname}${url.search}` !== request.path || !registry.fetches(url.pathname))
		throw new Error(`${request.path} isn't a package fetch on ${request.registry}.`)
	const response = await retryingFetch(send, defaultFetchRetry)(url.href, {
		headers: { accept: request.accept ?? '*/*', 'user-agent': 'mesh-flow' },
		signal: abortSignal,
	})
	const body = Buffer.from(await response.arrayBuffer()).toString('base64')
	const headers = Object.fromEntries(
		keptHeaders.flatMap((name) => (response.headers.has(name) ? [[name, response.headers.get(name) ?? '']] : [])),
	)
	return { status: response.status, headers, body }
}
