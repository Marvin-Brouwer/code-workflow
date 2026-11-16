import type { PackageRequest, PackageResponse } from '@mesh-flow/protocol'
import { defaultFetchRetry, retryingFetch } from '../http/retrying-fetch.mts'
import { untilAborted } from '../until-aborted.mts'
import { publicRegistries } from './public-registries.mts'

/**
 * The headers of a registry's answer that a package manager uses: what the body is, what version of
 * it, and where a redirect goes. A redirect goes back to the package manager: one to another host
 * fails at the proxy's `CONNECT`, and one on the same registry is checked here again.
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

/** How {@link fetchPackage} fetches. */
export interface PackageFetchOptions {
	/** The host's `fetch`. */
	readonly fetchFromHost: typeof fetch
	/** The largest body it takes. Default: {@link maxPackageBytes}. */
	readonly maxBytes?: number
}

/**
 * Fetches a package or its metadata from a public registry, for a package manager in a sandbox that
 * has no network. Only reads: a path the registry doesn't serve packages on, or one that isn't
 * already normalized (`..`, `//`), is turned down before anything is sent. Whatever the registry
 * answers is the answer, a 404 too; package managers ask for what may not exist. A redirect isn't
 * followed here: it's handed back, so the next fetch goes through the same checks.
 *
 * @throws When the path isn't a package fetch on that registry, and when the body is larger than
 * `maxBytes`.
 */
export async function fetchPackage(
	request: PackageRequest,
	options: PackageFetchOptions,
	abortSignal: AbortSignal,
): Promise<PackageResponse> {
	const { fetchFromHost, maxBytes = maxPackageBytes } = options
	const registry = publicRegistries[request.registry]
	const url = new URL(request.path, registry.origin)
	if (url.origin !== registry.origin || `${url.pathname}${url.search}` !== request.path || !registry.fetches(url.pathname))
		throw new Error(`${request.path} isn't a package fetch on ${request.registry}.`)
	// Settles once the signal aborts, also when the host's fetch or its body doesn't.
	return untilAborted(fetchedFrom(url, request, fetchFromHost, maxBytes, abortSignal), abortSignal)
}

/** Fetches `url` and reads the answer, capped at `maxBytes`. A body that comes after an abort is cancelled. */
async function fetchedFrom(
	url: URL,
	request: PackageRequest,
	fetchFromHost: typeof fetch,
	maxBytes: number,
	abortSignal: AbortSignal,
): Promise<PackageResponse> {
	const response = await retryingFetch(fetchFromHost, defaultFetchRetry)(url.href, {
		headers: { accept: request.accept ?? anyMediaType, 'user-agent': userAgent },
		redirect: 'manual',
		signal: abortSignal,
	})
	if (abortSignal.aborted) {
		await response.body?.cancel()
		abortSignal.throwIfAborted()
	}
	const body = (await cappedBody(response, maxBytes, `${request.registry} ${request.path}`)).toString('base64')
	const headers = Object.fromEntries(
		keptHeaders.flatMap((name) => (response.headers.has(name) ? [[name, response.headers.get(name) ?? '']] : [])),
	)
	return { status: response.status, headers, body }
}

/** The response's body, read until it's over `maxBytes`. `fetched` says what it is, for the error. */
async function cappedBody(response: Response, maxBytes: number, fetched: string): Promise<Buffer> {
	const tooLarge = () => new Error(`${fetched} is larger than ${megabytes(maxBytes)}, the most a package fetch takes.`)
	if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
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
		if (size > maxBytes) {
			await reader.cancel()
			throw tooLarge()
		}
		chunks.push(Buffer.from(value))
	}
	return Buffer.concat(chunks)
}

/** A size in bytes as MB, or in bytes when it's smaller than one. */
function megabytes(bytes: number): string {
	return bytes < bytesPerMb ? `${String(bytes)} bytes` : `${String(bytes / bytesPerMb)} MB`
}
