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

/** Fetches a package from one of the app's registries, on the run's endpoint. */
export function gatewayPackages(gateway: GatewayClient): (request: PackageRequest, abortSignal: AbortSignal) => Promise<StagedPackage> {
	return async (request, abortSignal) => {
		const answer = PackageResponse.parse(await gateway.call(gateway.run, { type: 'package', request }, abortSignal))
		return { status: answer.status, headers: answer.headers, file: gateway.staged(answer.body), size: answer.size }
	}
}
