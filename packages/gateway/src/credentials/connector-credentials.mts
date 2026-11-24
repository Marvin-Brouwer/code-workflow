import type { CredentialStore } from './credential-store.mts'

/**
 * The names the gateway and the engine keep their own credentials under, which no connector may
 * take as its name: model providers' keys (`provider/<name>`) and webhook secrets
 * (`webhook/<webhook>`).
 */
const reservedCredentialNamespaces: readonly string[] = ['provider', 'webhook']

/**
 * The part of the credential store that belongs to one connector: the credentials named
 * `<connector>/...`, such as `aws/session`. A connector writes its session there, and through it
 * can't change anything else, such as another connector's token or a model provider's key.
 *
 * It keeps connectors from overwriting each other's credentials. It isn't a wall: a connector's
 * host half runs in the engine's process, and its tools read the other credentials they need,
 * such as `jira/token`, through their context.
 *
 * ```ts
 * const credentials = connectorCredentials(gatewayHome.credentials, 'aws')
 * await credentials.set('aws/session', session, abortSignal)
 * ```
 */
export function connectorCredentials(store: CredentialStore, connector: string): CredentialStore {
	if (reservedCredentialNamespaces.includes(connector))
		throw new Error(`A connector can't be named ${connector}: the credentials named ${connector}/... aren't a connector's.`)
	const prefix = `${connector}/`
	const own = (name: string): string => {
		if (!name.startsWith(prefix)) throw new Error(`Connector ${connector} only has the credentials named ${prefix}..., not ${name}.`)
		return name
	}
	// async, so a name outside the connector's rejects like any other failure instead of throwing.
	return Object.freeze<CredentialStore>({
		get: async (name, abortSignal) => store.get(own(name), abortSignal),
		set: async (name, secret, abortSignal) => store.set(own(name), secret, abortSignal),
		update: async (name, next, abortSignal) => store.update(own(name), next, abortSignal),
		remove: async (name, abortSignal) => store.remove(own(name), abortSignal),
		names: async (abortSignal) => (await store.names(abortSignal)).filter((name) => name.startsWith(prefix)),
	})
}
