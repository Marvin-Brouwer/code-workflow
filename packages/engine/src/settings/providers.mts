import { knownKinds, providerCredential, ProviderName, type GatewayHome } from '@mesh-flow/gateway'
import { EngineError } from '../engine/engine-error.mts'

/** A provider as the CLI and the UI list it: its setting, and whether its key is set, never the key. */
export interface ListedProvider {
	readonly name: string
	readonly kind: string
	readonly baseUrl?: string
	readonly hasKey: boolean
}

/** What adding or changing a provider takes. */
export interface ProviderInput {
	readonly name: string
	readonly kind: string
	/** Another base URL than the kind's, for a proxy or a compatible server. */
	readonly baseUrl?: string
	/** Its API key. Left out, the key it has stays. */
	readonly key?: string
}

/** The providers in the order models are looked up, with whether each has a key. */
export async function listProviders(home: GatewayHome, abortSignal: AbortSignal): Promise<ListedProvider[]> {
	const keys = new Set(await home.credentials.names(abortSignal))
	return (await home.providers.list(abortSignal)).map(({ name, kind, baseUrl }) => ({
		name,
		kind,
		...(baseUrl === undefined ? {} : { baseUrl }),
		hasKey: keys.has(providerCredential(name)),
	}))
}

/** Adds a provider at the end of the list, or changes the one with its name, and sets its key when one is given. */
export async function putProvider(home: GatewayHome, input: ProviderInput, abortSignal: AbortSignal): Promise<void> {
	if (!knownKinds().some((known) => known.kind === input.kind))
		throw new EngineError('invalid', `There is no provider kind ${input.kind}. See \`mesh-flow provider kinds\`.`)
	const name = ProviderName.safeParse(input.name)
	if (!name.success)
		throw new EngineError('invalid', `${input.name} isn't a provider name: ${name.error.issues.map(({ message }) => message).join(' ')}`)
	const baseUrl = input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }
	await home.providers.put({ name: name.data, kind: input.kind, ...baseUrl }, abortSignal)
	if (input.key !== undefined && input.key.length > 0) await home.credentials.set(providerCredential(name.data), input.key, abortSignal)
}

/** Sets the API key of a provider that is there. */
export async function setProviderKey(home: GatewayHome, name: string, key: string, abortSignal: AbortSignal): Promise<void> {
	if (key.length === 0) throw new EngineError('invalid', 'The key is empty.')
	if (!(await home.providers.list(abortSignal)).some((known) => known.name === name))
		throw new EngineError('not-found', `There is no provider ${name}. Add it with \`mesh-flow provider add\`.`)
	await home.credentials.set(providerCredential(name), key, abortSignal)
}

/** Removes a provider and its key. */
export async function removeProvider(home: GatewayHome, name: string, abortSignal: AbortSignal): Promise<void> {
	const removed = await home.providers.remove(name, abortSignal)
	await home.credentials.remove(providerCredential(name), abortSignal)
	if (!removed) throw new EngineError('not-found', `There is no provider ${name}.`)
}
