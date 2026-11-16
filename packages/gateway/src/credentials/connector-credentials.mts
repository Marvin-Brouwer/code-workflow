import type { CredentialStore } from './credential-store.mts'

/**
 * The part of the credential store that belongs to one connector: the credentials named
 * `<connector>/...`, such as `aws/session`. A connector keeps its session there, and can't read or
 * change anything else, such as another connector's token or a model provider's key.
 *
 * ```ts
 * const credentials = connectorCredentials(gatewayHome.credentials, 'aws')
 * await credentials.set('aws/session', session, abortSignal)
 * ```
 */
export function connectorCredentials(store: CredentialStore, connector: string): CredentialStore {
	const prefix = `${connector}/`
	const own = (name: string): string => {
		if (!name.startsWith(prefix)) throw new Error(`Connector ${connector} only has the credentials named ${prefix}..., not ${name}.`)
		return name
	}
	return Object.freeze<CredentialStore>({
		get: async (name, abortSignal) => store.get(own(name), abortSignal),
		set: async (name, secret, abortSignal) => store.set(own(name), secret, abortSignal),
		update: async (name, next, abortSignal) => store.update(own(name), next, abortSignal),
		remove: async (name, abortSignal) => store.remove(own(name), abortSignal),
		names: async (abortSignal) => (await store.names(abortSignal)).filter((name) => name.startsWith(prefix)),
	})
}
