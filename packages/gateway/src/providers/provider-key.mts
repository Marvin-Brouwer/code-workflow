import { openAiCompatibleKind, type ModelProviderDescription } from '@mesh-flow/protocol'
import { z } from 'zod'
import type { CredentialReader, CredentialStore } from '../credentials/credential-store.mts'
import { modelsOfKind } from './model-apis.mts'
import { providerCredential } from './provider-credential.mts'

/**
 * A provider's key as the credential store keeps it: with the origin it was set for. The key only
 * goes to that origin, so a config that sends the provider elsewhere needs the key set again.
 */
const StoredKey = z.object({ key: z.string().min(1), origin: z.string().min(1) })

/** Whether a provider has a key for where the config sends it: `set`, none, or one set for another origin. */
export type ProviderKey =
	| { readonly status: 'set'; readonly key: string }
	| { readonly status: 'missing' }
	| { readonly status: 'elsewhere'; readonly origin: string }

/**
 * Where the config sends `provider`'s requests: the origin of its base URL, or of its kind's. `undefined`
 * for a kind the gateway doesn't know, which gets no key.
 */
export function providerOrigin(provider: ModelProviderDescription): string | undefined {
	const baseUrl = provider.baseUrl ?? (provider.kind === openAiCompatibleKind ? undefined : modelsOfKind(provider.kind)?.[0]?.baseUrl)
	return baseUrl === undefined ? undefined : new URL(baseUrl).origin
}

/** Sets `provider`'s key, for where the config sends it now. Throws for a kind the gateway doesn't know. */
export async function storeProviderKey(
	credentials: CredentialStore,
	provider: ModelProviderDescription,
	key: string,
	abortSignal: AbortSignal,
): Promise<void> {
	const origin = providerOrigin(provider)
	if (origin === undefined)
		throw new Error(`The gateway can't send model calls for provider kind ${provider.kind} (provider ${provider.name}).`)
	await credentials.set(providerCredential(provider.name), JSON.stringify({ key, origin }), abortSignal)
}

/** `provider`'s key, if it has one for where the config sends it now. */
export async function providerKeyOf(
	credentials: CredentialReader,
	provider: ModelProviderDescription,
	abortSignal: AbortSignal,
): Promise<ProviderKey> {
	const stored = await credentials.get(providerCredential(provider.name), abortSignal)
	if (stored === undefined) return { status: 'missing' }
	const parsed = StoredKey.safeParse(parseJson(stored))
	if (!parsed.success) return { status: 'missing' }
	if (parsed.data.origin !== providerOrigin(provider)) return { status: 'elsewhere', origin: parsed.data.origin }
	return { status: 'set', key: parsed.data.key }
}

/** `text` as JSON, or `undefined` when it isn't. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}
