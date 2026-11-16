import { PackageResponse, type PackageRequest } from '@mesh-flow/protocol'
import type { GatewayClient } from './gateway-client.mts'

/** Fetches a package from one of the app's registries, on the run's endpoint. */
export function gatewayPackages(gateway: GatewayClient): (request: PackageRequest, abortSignal: AbortSignal) => Promise<PackageResponse> {
	return async (request, abortSignal) => PackageResponse.parse(await gateway.call(gateway.run, { type: 'package', request }, abortSignal))
}
