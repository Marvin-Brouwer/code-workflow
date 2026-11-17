import { PackageResponse, type PackageRequest } from '@mesh-flow/protocol'
import type { GatewayClient } from './gateway-client.mts'

/** What a registry answered a package fetch with: the body is in a file the engine staged. */
export interface StagedPackage {
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	/** The body's file. Whoever reads it removes it. */
	readonly file: string
	/** The body's length, in bytes. */
	readonly size: number
}

/** How a package is fetched through the gateway: what the proxy and `fetchPackage` call. */
export type GatewayFetch = (request: PackageRequest, abortSignal: AbortSignal) => Promise<StagedPackage>

/** Fetches a package from one of the app's registries, on the run's package endpoint. */
export function packageFetchThroughGateway(gateway: GatewayClient): GatewayFetch {
	return async (request, abortSignal) => {
		if (gateway.packages === undefined) throw new Error('The run has no package endpoint: its app restores from no registry.')
		const answer = PackageResponse.parse(await gateway.call(gateway.packages, { type: 'package', request }, abortSignal))
		return { status: answer.status, headers: answer.headers, file: gateway.staged(answer.body), size: answer.size }
	}
}
