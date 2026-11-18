import type { ConnectorRegistry, PackageRequest } from '@mesh-flow/protocol'
import { defaultFetchRetry, retryingFetch } from '../http/retrying-fetch.mts'
import { ownEntry } from '../own-entry.mts'
import { isRegistryPath } from './registry-path.mts'
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
	if (resolve === undefined) throw new Error(`${registry.name} needs connector ${registry.connector}, which isn't loaded.`)
	const checked: ConnectorRegistryRequest = { registry, path, ...(accept === undefined ? {} : { accept }) }
	if (!isRegistryPath(registry, path)) throw new Error(`${path} isn't a package fetch on ${registry.name}.`)
	return { request: checked, resolve }
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
	const fetched = `${request.registry.name} ${request.path}`
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
			throw new Error(`${request.registry.name} redirected ${request.path} to ${next.protocol} instead of HTTPS.`)
		if (redirects === maxRedirects)
			throw new Error(`${request.registry.name} redirected ${request.path} more than ${String(maxRedirects)} times.`)
		url = next.href
	}
}
