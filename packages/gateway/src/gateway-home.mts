import path from 'node:path'
import { openCredentialStore, type CredentialStore } from './credentials/credential-store.mts'
import { defaultStoreKey } from './credentials/store-key.mts'
import { openProviderSettings, type ProviderSettings } from './providers/provider-settings.mts'

/** A gateway's directory on the host, and what is kept in it. */
export interface GatewayHome {
	readonly directory: string
	/** The sealed credentials: provider keys, webhook secrets and what connectors need. */
	readonly credentials: CredentialStore
	/** The user's model providers, in order. */
	readonly providers: ProviderSettings
	/** Where the key the credentials are sealed with is, for the log. */
	readonly keyIsIn: string
}

/**
 * Opens a gateway's directory: `credentials.json`, sealed with a key from the OS keychain or, where
 * there is none, `store.key` next to it; `providers.json`; and `runs/`, the state of the runs it
 * serves. The engine and the CLI open the same one.
 */
export async function openGatewayHome(directory: string, abortSignal: AbortSignal): Promise<GatewayHome> {
	const key = await defaultStoreKey(directory, abortSignal)
	return {
		directory,
		credentials: openCredentialStore(path.join(directory, 'credentials.json'), key),
		providers: openProviderSettings(path.join(directory, 'providers.json')),
		keyIsIn: key.where,
	}
}
