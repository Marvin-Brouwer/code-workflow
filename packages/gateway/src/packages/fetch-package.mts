import { registryName, type ConnectorRegistry, type PackageRequest } from '@mesh-flow/protocol'
import { messageOf } from '../errors.mts'
import { defaultFetchRetry, retryingFetch } from '../http/retrying-fetch.mts'
import { HostToolTransientError } from '../tools/host-tool.mts'
import { untilAborted } from '../until-aborted.mts'
import type { RegistryFetch } from './connector-registry.mts'
import { publicRegistries } from './public-registries.mts'

/**
 * The headers of a registry's answer that a package manager uses: what the body is, what version of
 * it, and where a redirect goes. A redirect from a public registry goes back to the package
 * manager: one to another host fails at the proxy's `CONNECT`, and one on the same registry is
 * checked here again.
 */
const keptHeaders = ['content-type', 'etag', 'last-modified', 'location']

/** What a fetch accepts when the package manager didn't say. */
const anyMediaType = '*/*'

/** How the gateway names itself to the registries. */
const userAgent = 'mesh-flow'

const bytesPerMb = 1024 * 1024

/**
 * The largest body a fetch takes, in bytes. The engine writes it into the sandbox as a file; the
 * largest packages on nuget.org are below this.
 */
export const maxPackageBytes = 256 * bytesPerMb

/** How many redirects a fetch on a connector's registry follows, as to a signed download URL. */
const maxRedirects = 3

/** How {@link fetchPackage} and {@link fetchFromConnectorRegistry} fetch. */
export interface PackageFetchOptions {
	/** The host's `fetch`. */
	readonly fetchFromHost: typeof fetch
	/** The largest body it takes. Default: {@link maxPackageBytes}. */
	readonly maxBytes?: number
}

/** What a registry answered, on the host: the body is staged for the sandbox, not sent in the answer. */
export interface FetchedPackage {
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly body: Buffer
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
): Promise<FetchedPackage> {
	if (typeof request.registry !== 'string') throw new Error(`${registryName(request.registry)} isn't a public registry.`)
	const registry = publicRegistries[request.registry]
	const url = new URL(request.path, registry.origin)
	if (url.origin !== registry.origin || `${url.pathname}${url.search}` !== request.path || !registry.fetches(url.pathname))
		throw new Error(`${request.path} isn't a package fetch on ${request.registry}.`)
	const { fetchFromHost, maxBytes = maxPackageBytes } = options
	const fetched = `${request.registry} ${request.path}`
	const send = retryingFetch(fetchFromHost, defaultFetchRetry)
	const headers = { accept: request.accept ?? anyMediaType, 'user-agent': userAgent }
	// Settles once the signal aborts, also when the host's fetch or its body doesn't.
	return untilAborted(
		(async () => {
			const response = await sent(send(url.href, { headers, redirect: 'manual', signal: abortSignal }), fetched, abortSignal)
			return fetchedOf(response, maxBytes, fetched, abortSignal)
		})(),
		abortSignal,
	)
}

/**
 * Whether `request` is a fetch on one of its connector registry's paths, already normalized (no
 * `..`, `//` or fragment), so a connector only has to say where it goes.
 */
export function isConnectorRegistryFetch(request: PackageRequest & { readonly registry: ConnectorRegistry }): boolean {
	const url = new URL(request.path, `https://${request.registry.host}`)
	return (
		url.host === request.registry.host &&
		`${url.pathname}${url.search}` === request.path &&
		!url.pathname.includes('//') &&
		request.registry.paths.some((prefix) => url.pathname.startsWith(prefix))
	)
}

/**
 * Fetches from a connector's registry, where the connector said the fetch goes. A redirect is
 * followed here, as to the signed URL a private registry hands out for a download, since the
 * proxy only takes the registry's own host; the connector's headers go to that host only.
 *
 * @throws When the body is larger than `maxBytes`, and after too many redirects.
 */
export function fetchFromConnectorRegistry(
	request: PackageRequest,
	where: RegistryFetch,
	options: PackageFetchOptions,
	abortSignal: AbortSignal,
): Promise<FetchedPackage> {
	// Settles once the signal aborts, also when the host's fetch or its body doesn't.
	return untilAborted(followedFetch(request, where, options, abortSignal), abortSignal)
}

/** Fetches where the connector said, following its redirects. */
async function followedFetch(
	request: PackageRequest,
	where: RegistryFetch,
	{ fetchFromHost, maxBytes = maxPackageBytes }: PackageFetchOptions,
	abortSignal: AbortSignal,
): Promise<FetchedPackage> {
	const fetched = `${registryName(request.registry)} ${request.path}`
	const send = retryingFetch(fetchFromHost, defaultFetchRetry)
	const origin = new URL(where.url).origin
	let url = where.url
	for (let redirects = 0; ; redirects++) {
		const headers = {
			accept: request.accept ?? anyMediaType,
			'user-agent': userAgent,
			...(new URL(url).origin === origin ? where.headers : {}),
		}
		const response = await sent(send(url, { headers, redirect: 'manual', signal: abortSignal }), fetched, abortSignal)
		const location = response.headers.get('location')
		if (response.status < 300 || response.status >= 400 || location === null) {
			return fetchedOf(response, maxBytes, fetched, abortSignal, ['location'])
		}
		await response.body?.cancel()
		const next = new URL(location, url)
		if (next.protocol !== 'https:')
			throw new Error(`${registryName(request.registry)} redirected ${request.path} to ${next.protocol} instead of HTTPS.`)
		if (redirects === maxRedirects)
			throw new Error(`${registryName(request.registry)} redirected ${request.path} more than ${String(maxRedirects)} times.`)
		url = next.href
	}
}

/** The host's answer to a fetch, once it came: a body that comes after an abort is cancelled. */
async function sent(sending: Promise<Response>, fetched: string, abortSignal: AbortSignal): Promise<Response> {
	const response = await asTransientOnNetworkFailure(sending, fetched, abortSignal)
	if (abortSignal.aborted) {
		await response.body?.cancel()
		abortSignal.throwIfAborted()
	}
	return response
}

/** The answer as the sandbox gets it: the status, the headers it needs, and the body, capped. */
async function fetchedOf(
	response: Response,
	maxBytes: number,
	fetched: string,
	abortSignal: AbortSignal,
	leftOut: readonly string[] = [],
): Promise<FetchedPackage> {
	const body = await cappedBody(response, maxBytes, fetched, abortSignal)
	const headers = Object.fromEntries(
		keptHeaders
			.filter((name) => !leftOut.includes(name))
			.flatMap((name) => (response.headers.has(name) ? [[name, response.headers.get(name) ?? '']] : [])),
	)
	return { status: response.status, headers, body }
}

/**
 * Awaits `reading`, and marks a failure of the network, such as a refused connection or one reset
 * partway, as one that may pass on another try: the proxy then answers 502, which package managers
 * try again, instead of the 403 of a refusal. An abort stays an abort.
 */
async function asTransientOnNetworkFailure<T>(reading: Promise<T>, fetched: string, abortSignal: AbortSignal): Promise<T> {
	try {
		return await reading
	} catch (error) {
		abortSignal.throwIfAborted()
		throw new HostToolTransientError(`${fetched} couldn't be fetched: ${messageOf(error)}`, { cause: error })
	}
}

/** The response's body, read until it's over `maxBytes`. `fetched` says what it is, for the error. */
async function cappedBody(response: Response, maxBytes: number, fetched: string, abortSignal: AbortSignal): Promise<Buffer> {
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
		const { done, value } = await asTransientOnNetworkFailure(reader.read(), fetched, abortSignal)
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
