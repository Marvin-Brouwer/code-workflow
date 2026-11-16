import type { PackageRequest, PackageResponse } from '@mesh-flow/protocol'
import { defaultFetchRetry, retryingFetch } from '../http/retrying-fetch.mts'
import { publicRegistries } from './public-registries.mts'

/**
 * The headers of a registry's answer that a package manager uses: what the body is, what version of
 * it, and where a redirect goes. The proxy in the sandbox refuses a redirect to another host.
 */
const keptHeaders = ['content-type', 'etag', 'last-modified', 'location']

/** What a fetch accepts when the package manager didn't say. */
const anyMediaType = '*/*'

/** How the gateway names itself to the registries. */
const userAgent = 'mesh-flow'

const bytesPerMb = 1024 * 1024

/**
 * The largest body a fetch takes, in bytes. It goes to the sandbox as base64 in one answer, which the
 * runtime holds in memory a few times over; the largest packages on nuget.org are below this.
 */
export const maxPackageBytes = 256 * bytesPerMb

/**
 * Fetches a package or its metadata from a public registry, for a package manager in a sandbox that
 * has no network. Only reads: a path the registry doesn't serve packages on, or one that isn't
 * already normalized (`..`, `//`), is turned down before anything is sent. Whatever the registry
 * answers is the answer, a 404 too; package managers ask for what may not exist. A redirect isn't
 * followed here: it's handed back, so the next fetch goes through the same checks.
 *
 * @throws When the path isn't a package fetch on that registry, and when the body is larger than
 * {@link maxPackageBytes}.
 */
export async function fetchPackage(
	request: PackageRequest,
	fetchFromHost: typeof fetch,
	abortSignal: AbortSignal,
): Promise<PackageResponse> {
	const registry = publicRegistries[request.registry]
	const url = new URL(request.path, registry.origin)
	if (url.origin !== registry.origin || `${url.pathname}${url.search}` !== request.path || !registry.fetches(url.pathname))
		throw new Error(`${request.path} isn't a package fetch on ${request.registry}.`)
	const response = await retryingFetch(fetchFromHost, defaultFetchRetry)(url.href, {
		headers: { accept: request.accept ?? anyMediaType, 'user-agent': userAgent },
		redirect: 'manual',
		signal: abortSignal,
	})
	const body = (await cappedBody(response, `${request.registry} ${request.path}`)).toString('base64')
	const headers = Object.fromEntries(
		keptHeaders.flatMap((name) => (response.headers.has(name) ? [[name, response.headers.get(name) ?? '']] : [])),
	)
	return { status: response.status, headers, body }
}

/** The response's body, read until it's over {@link maxPackageBytes}. */
async function cappedBody(response: Response, what: string): Promise<Buffer> {
	const tooLarge = () => new Error(`${what} is larger than ${String(maxPackageBytes / bytesPerMb)} MB, the most a package fetch takes.`)
	if (Number(response.headers.get('content-length') ?? 0) > maxPackageBytes) {
		await response.body?.cancel()
		throw tooLarge()
	}
	if (response.body === null) return Buffer.alloc(0)
	// A fetch body is bytes; the types leave its chunks `any`.
	const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
	const chunks: Buffer[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > maxPackageBytes) {
			await reader.cancel()
			throw tooLarge()
		}
		chunks.push(Buffer.from(value))
	}
	return Buffer.concat(chunks)
}
