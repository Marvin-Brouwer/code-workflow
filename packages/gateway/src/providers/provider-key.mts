import { openAiCompatibleKind, type ModelProviderDescription } from '@mesh-flow/protocol'
import { z } from 'zod'
import type { CredentialReader, CredentialStore } from '../credentials/credential-store.mts'
import { modelsOfKind } from './model-apis.mts'
import { providerCredential } from './provider-credential.mts'
import { isSendable, unsendableKindMessage } from './sendable-kind.mts'
import { webOrigin } from './web-origin.mts'

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
 * Where the config sends `provider`'s requests: the origin of its base URL, or of its kind's when
 * all of the kind's models are on one. `undefined` when there is no single web origin, such as for
 * a kind the gateway doesn't know or one whose base URL the config has to give: it gets no key.
 */
export function providerOrigin(provider: ModelProviderDescription): string | undefined {
	if (provider.baseUrl !== undefined) return webOrigin(provider.baseUrl)
	if (provider.kind === openAiCompatibleKind) return undefined
	const origins = new Set((modelsOfKind(provider.kind) ?? []).map((model) => webOrigin(model.baseUrl)))
	const [origin, ...others] = origins
	return others.length === 0 ? origin : undefined
}

/**
 * Why `provider` can't get a key: its kind isn't one the gateway sends for, or it has no single
 * origin to tie the key to until the config gives it a base URL, as `azure` needs.
 */
export function noOriginMessage(provider: ModelProviderDescription): string {
	if (!isSendable(provider)) return unsendableKindMessage(provider)
	return `Provider ${provider.name} has no base URL to tie its key to: give it an http(s) \`baseUrl\` in \`modelProviders\`.`
}

/** Stores `provider`'s key, with the origin the config sends it to now. Throws, with {@link noOriginMessage}, when it has none. */
export async function storeProviderKey(
	credentials: CredentialStore,
	provider: ModelProviderDescription,
	key: string,
	abortSignal: AbortSignal,
): Promise<void> {
	const origin = providerOrigin(provider)
	if (origin === undefined) throw new Error(noOriginMessage(provider))
	await credentials.set(providerCredential(provider.name), JSON.stringify({ key, origin }), abortSignal)
}

/**
 * `provider`'s key, if it has one for where the config sends it now. A key stored without an
 * origin, as before keys were tied to one, counts as missing.
 */
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
