import path from 'node:path'
import { openGatewayHome, type GatewayHome } from '@mesh-flow/gateway'
import { moveLegacyWebhookSecrets } from '../triggers/webhook-secrets.mts'

/** Where the gateway lives in an engine's home. */
export function gatewayDirectory(home: string): string {
	return path.join(home, 'gateway')
}

/** How an engine's gateway is opened. */
export interface EngineGatewayOptions {
	/** Whether the credential store's key may be kept in the OS keychain. Default: yes. */
	readonly keychain?: boolean
}

/**
 * Opens the gateway's directory in an engine's home, as the engine and the CLI both do, and moves
 * webhook secrets from where engines kept them before into its credential store.
 */
export async function openEngineGateway(home: string, abortSignal: AbortSignal, options: EngineGatewayOptions = {}): Promise<GatewayHome> {
	const gateway = await openGatewayHome(
		gatewayDirectory(home),
		abortSignal,
		options.keychain === undefined ? {} : { keychain: options.keychain },
	)
	await moveLegacyWebhookSecrets(home, gateway.credentials, abortSignal)
	return gateway
}
