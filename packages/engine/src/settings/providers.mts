import { providerCredential, type GatewayHome } from '@mesh-flow/gateway'
import { ProviderName, type ModelProviderDescription } from '@mesh-flow/protocol'
import { EngineError } from '../engine/engine-error.mts'

/** A provider as the CLI and the UI list it: as the app's config declares it, and whether its key is set, never the key. */
export interface ListedProvider {
	readonly name: string
	readonly kind: string
	readonly baseUrl?: string | undefined
	readonly hasKey: boolean
}

/** The providers the app's config declares, in the order models are looked up, with whether each has a key. */
export async function listProviders(
	home: GatewayHome,
	declared: readonly ModelProviderDescription[],
	abortSignal: AbortSignal,
): Promise<ListedProvider[]> {
	const keys = new Set(await home.credentials.names(abortSignal))
	return declared.map(({ name, kind, baseUrl }) => ({
		name,
		kind,
		...(baseUrl === undefined ? {} : { baseUrl }),
		hasKey: keys.has(providerCredential(name)),
	}))
}

/** Sets the API key of the provider `name`, as the app's config names it. */
export async function setProviderKey(home: GatewayHome, name: string, key: string, abortSignal: AbortSignal): Promise<void> {
	if (key.length === 0) throw new EngineError('invalid', 'The key is empty.')
	await home.credentials.set(providerCredential(checkedName(name)), key, abortSignal)
}

/** Removes the API key of the provider `name`. The provider stays in the config, without a key. */
export async function removeProviderKey(home: GatewayHome, name: string, abortSignal: AbortSignal): Promise<void> {
	if (!(await home.credentials.remove(providerCredential(checkedName(name)), abortSignal)))
		throw new EngineError('not-found', `Provider ${name} has no key.`)
}

function checkedName(name: string): string {
	const checked = ProviderName.safeParse(name)
	if (!checked.success)
		throw new EngineError('invalid', `${name} isn't a provider name: ${checked.error.issues.map(({ message }) => message).join(' ')}`)
	return checked.data
}
