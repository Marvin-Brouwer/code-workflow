import path from 'node:path'
import type { CallMessage, GatewayCall } from '@mesh-flow/protocol'
import { openCredentialStore } from '../../src/credentials/credential-store.mts'
import { keyFile } from '../../src/credentials/store-key.mts'
import { openGateway, type Gateway, type GatewayOptions } from '../../src/gateway.mts'
import { openProviderSettings } from '../../src/providers/provider-settings.mts'
import { temporaryDirectory } from './temporary-directory.mts'

export const abortSignal = new AbortController().signal

/** A gateway in a fresh directory, with a key file instead of the OS keychain. */
export async function testGateway(options: Partial<Pick<GatewayOptions, 'tools' | 'fetch'>> & { readonly home?: string } = {}) {
	const home = options.home ?? (await temporaryDirectory())
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	const providers = openProviderSettings(path.join(home, 'providers.json'))
	const gateway = openGateway({ home, credentials, providers, ...options })
	return { home, gateway, credentials, providers }
}

let calls = 0

/** A call message on `endpoint` with `token`. Each gets its own id. */
export function callOf(endpoint: string, token: string, call: GatewayCall, id = `call-${String(++calls)}`): CallMessage {
	return { type: 'call', id, endpoint, token, call }
}

/** Accepts and answers a call. */
export async function callGateway(gateway: Gateway, runId: string, message: CallMessage) {
	const accepted = await gateway.accept(runId, message, abortSignal)
	const answer = await accepted.answer(abortSignal)
	await gateway.settle(runId, message.id, abortSignal)
	return { ...accepted, answer }
}
