import { PackageResponse, type PackageRequest } from '@mesh-flow/protocol'
import type { GatewayClient } from './gateway-client.mts'

/** How a package is fetched through the gateway: what the proxy and `fetchPackage` call. */
export type GatewayFetch = (request: PackageRequest, abortSignal: AbortSignal) => Promise<PackageResponse>

/** Fetches a package from one of the app's registries, on the run's endpoint. */
export function gatewayPackages(gateway: GatewayClient): GatewayFetch {
	return async (request, abortSignal) => PackageResponse.parse(await gateway.call(gateway.run, { type: 'package', request }, abortSignal))
}
