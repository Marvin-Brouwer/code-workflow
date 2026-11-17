import { registryName, type ConnectorRegistry, type PackageRequest } from '@mesh-flow/protocol'
import { defaultFetchRetry, retryingFetch } from '../http/retrying-fetch.mts'
import { ownEntry } from '../own-entry.mts'
import { untilAborted } from '../until-aborted.mts'
import type { ConnectorRegistryRequest, RegistryTarget, ResolveRegistryTarget } from './connector-registry.mts'
import {
	anyMediaType,
	fetchedOf,
	maxPackageBytes,
	sent,
	userAgent,
	type RegistryAnswer,
	type RegistryFetchOptions,
} from './fetch-from-public-registry.mts'

/** How many redirects a fetch on a connector's registry follows, as to a signed download URL. */
const maxRedirects = 3

/**
 * The fetch `request` is on a connector's registry, once it's checked: the connector is loaded,
 * and the path is one of the registry's, already normalized. Checked before the cache too, so a
 * cached package isn't served from a registry no loaded connector serves.
 *
 * @throws When the connector isn't loaded, or the path isn't a package fetch on the registry.
 */
export function connectorRegistryFetch(
	request: PackageRequest & { readonly registry: ConnectorRegistry },
	resolvers: Readonly<Record<string, ResolveRegistryTarget>>,
): { readonly request: ConnectorRegistryRequest; readonly resolve: ResolveRegistryTarget } {
	const { registry, path, accept } = request
	const resolve = ownEntry(resolvers, registry.connector)
	if (resolve === undefined) throw new Error(`${registryName(registry)} needs connector ${registry.connector}, which isn't loaded.`)
	const checked: ConnectorRegistryRequest = { registry, path, ...(accept === undefined ? {} : { accept }) }
	if (!isConnectorRegistryRequest(checked)) throw new Error(`${path} isn't a package fetch on ${registry.name}.`)
	return { request: checked, resolve }
}

/**
 * Whether `request` is a fetch on one of its connector registry's paths, already normalized (no
 * `..`, `//` or fragment), so a connector only has to say where it goes.
 */
export function isConnectorRegistryRequest(request: ConnectorRegistryRequest): boolean {
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
	where: RegistryTarget,
	options: RegistryFetchOptions,
	abortSignal: AbortSignal,
): Promise<RegistryAnswer> {
	// Settles once the signal aborts, also when the host's fetch or its body doesn't.
	return untilAborted(followedFetch(request, where, options, abortSignal), abortSignal)
}

/** Fetches where the connector said, following its redirects. */
async function followedFetch(
	request: PackageRequest,
	where: RegistryTarget,
	{ fetchFromHost, maxBytes = maxPackageBytes }: RegistryFetchOptions,
	abortSignal: AbortSignal,
): Promise<RegistryAnswer> {
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
