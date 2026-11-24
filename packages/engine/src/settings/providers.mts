import { providerCredential, providerKeyOf, providerModels, providerOrigin, storeProviderKey, type GatewayHome } from '@mesh-flow/gateway'
import { ProviderName, type ModelProviderDescription } from '@mesh-flow/protocol'
import { EngineError } from '../engine/engine-error.mts'

/** A provider as the CLI and the UI list it: as the app's config declares it, and whether its key is set, never the key. */
export interface ListedProvider {
	readonly name: string
	readonly kind: string
	readonly baseUrl?: string | undefined
	/** Whether it has a key for where the config sends it now. */
	readonly hasKey: boolean
	/** Where its key was set for, when that isn't where the config sends it now: the key isn't used until it's set again. */
	readonly keySetFor?: string | undefined
}

/** The providers the app's config declares, in the order models are looked up, with whether each has a key. */
export async function listProviders(
	home: GatewayHome,
	declared: readonly ModelProviderDescription[],
	abortSignal: AbortSignal,
): Promise<ListedProvider[]> {
	return Promise.all(
		declared.map(async (provider): Promise<ListedProvider> => {
			const { name, kind, baseUrl } = provider
			const key = await providerKeyOf(home.credentials, provider, abortSignal)
			return {
				name,
				kind,
				...(baseUrl === undefined ? {} : { baseUrl }),
				hasKey: key.status === 'set',
				...(key.status === 'elsewhere' ? { keySetFor: key.origin } : {}),
			}
		}),
	)
}

/** A model a provider offers, as the CLI and the UI list it: whether agents can use it. */
export interface ListedModel {
	readonly id: string
	readonly usable: boolean
}

/**
 * The models a provider offers its key, as the CLI and the UI show them. `provider`: as the
 * provider listed them. `catalog`: it has no model list, so they're pi-ai's catalog of its kind.
 * `failed`: it didn't list them, with why.
 */
export type ProviderModelList =
	| { readonly source: 'provider' | 'catalog'; readonly models: readonly ListedModel[] }
	| { readonly source: 'failed'; readonly reason: string }

/** Asks the provider `name` of the app's config, with its key, which models it offers. */
export async function listProviderModels(
	home: GatewayHome,
	declared: readonly ModelProviderDescription[],
	name: string,
	abortSignal: AbortSignal,
	fetchFromHost: typeof fetch = fetch,
): Promise<ProviderModelList> {
	const provider = declaredProvider(declared, name)
	const key = await providerKeyOf(home.credentials, provider, abortSignal)
	if (key.status !== 'set')
		throw new EngineError('invalid', `Provider ${name} has no key for where the config sends it, so it can't be asked for its models.`)
	const models = await providerModels(provider, { key: key.key, fetchFromHost }, abortSignal)
	if (models.source === 'failed') return models
	return {
		source: models.source,
		models: [...models.usable.map(({ id }) => ({ id, usable: true })), ...models.unusable.map((id) => ({ id, usable: false }))],
	}
}

/**
 * Sets the API key of the provider `name` of the app's config, for where the config sends it now:
 * the key goes nowhere else, so a config that changes the provider's base URL needs it set again.
 */
export async function setProviderKey(
	home: GatewayHome,
	declared: readonly ModelProviderDescription[],
	name: string,
	key: string,
	abortSignal: AbortSignal,
): Promise<void> {
	if (key.length === 0) throw new EngineError('invalid', 'The key is empty.')
	const provider = declaredProvider(declared, checkedName(name))
	// Checked here too, so the refusal is an EngineError the CLI and the UI show as invalid.
	if (providerOrigin(provider) === undefined)
		throw new EngineError('invalid', `The gateway can't send model calls for provider ${name}'s kind ${provider.kind}.`)
	await storeProviderKey(home.credentials, provider, key, abortSignal)
}

/** The provider `name` of the app's config, or a `not-found` refusal. */
function declaredProvider(declared: readonly ModelProviderDescription[], name: string): ModelProviderDescription {
	const provider = declared.find((known) => known.name === name)
	if (provider === undefined) throw new EngineError('not-found', `The app's config declares no provider ${name}.`)
	return provider
}

/** Removes the API key of the provider `name`. The provider stays in the config, without a key. */
export async function removeProviderKey(home: GatewayHome, name: string, abortSignal: AbortSignal): Promise<void> {
	if (!(await home.credentials.remove(providerCredential(checkedName(name)), abortSignal)))
		throw new EngineError('not-found', `Provider ${name} has no key.`)
}

/** `name` as a provider's name, or an `invalid` refusal that says why it can't be one. */
function checkedName(name: string): string {
	const checked = ProviderName.safeParse(name)
	if (!checked.success)
		throw new EngineError('invalid', `${name} isn't a provider name: ${checked.error.issues.map(({ message }) => message).join(' ')}`)
	return checked.data
}
