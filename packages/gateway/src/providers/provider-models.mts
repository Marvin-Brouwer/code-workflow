import type { Api, Model } from '@earendil-works/pi-ai'
import { openAiCompatibleKind, type ModelProviderDescription } from '@mesh-flow/protocol'
import { z } from 'zod'
import { untilAborted } from '../until-aborted.mts'
import { compatibleModel, modelApi, modelsOfKind, type ModelApi } from './model-apis.mts'

/** What a provider's model list answers: Anthropic's `GET /v1/models` and OpenAI's `GET /models` both have this shape. */
const ModelList = z.object({ data: z.array(z.object({ id: z.string().min(1) })) })

/** Answers that say the provider has no model list, so pi-ai's catalog stands in. */
const noListStatuses = new Set([404, 405, 501])

/**
 * The models a provider offers its key. `provider`: as the provider listed them. `catalog`: the
 * provider has no model list, so they're pi-ai's catalog of its kind.
 */
export interface ListedModels {
	readonly source: 'provider' | 'catalog'
	/** The models agents can use: ones pi-ai knows, or any model of a compatible server. */
	readonly usable: readonly Model<Api>[]
	/** Models the provider listed that agents can't use, since pi-ai doesn't know them, such as embedding models. */
	readonly unusable: readonly string[]
}

/** A provider that didn't list its models, such as for a key it doesn't take: why. */
export interface UnlistedModels {
	readonly source: 'failed'
	readonly reason: string
}

export type ProviderModels = ListedModels | UnlistedModels

/** How a provider lists its models: the URL, and the API whose headers carry the key. */
interface ModelListing {
	readonly url: string
	readonly api: ModelApi
}

/**
 * Where a provider lists its models: on the API of its kind's first model, at the config's base
 * URL or that model's. `undefined` when the gateway sends none of its kind's models.
 */
function listingOf(provider: ModelProviderDescription): ModelListing | undefined {
	const first =
		provider.kind === openAiCompatibleKind
			? { api: 'openai-completions' as const, baseUrl: provider.baseUrl ?? '' }
			: modelsOfKind(provider.kind)?.[0]
	const api = first === undefined ? undefined : modelApi(first.api)
	if (first === undefined || api === undefined) return undefined
	return { url: `${(provider.baseUrl ?? first.baseUrl).replace(/\/+$/, '')}${api.list.path}`, api }
}

async function askedModels(
	provider: ModelProviderDescription,
	key: string,
	fetchFromHost: typeof fetch,
	abortSignal: AbortSignal,
): Promise<ProviderModels> {
	const catalog = modelsOfKind(provider.kind) ?? []
	const listing = listingOf(provider)
	if (listing === undefined) return { source: 'catalog', usable: catalog, unusable: [] }
	const { url, api } = listing
	const response = await fetchFromHost(url, { headers: { ...api.list.headers, ...api.credential(key) }, signal: abortSignal })
	if (noListStatuses.has(response.status)) return { source: 'catalog', usable: catalog, unusable: [] }
	if (!response.ok) return { source: 'failed', reason: `Provider ${provider.name} didn't list its models: it answered ${response.status}.` }
	const listed = ModelList.safeParse(await response.json().catch(() => undefined))
	if (!listed.success)
		return { source: 'failed', reason: `Provider ${provider.name} didn't list its models: its answer isn't a model list.` }
	const ids = listed.data.data.map((model) => model.id)
	if (provider.kind === openAiCompatibleKind)
		return { source: 'provider', usable: ids.map((id) => compatibleModel(provider, id)), unusable: [] }
	return {
		source: 'provider',
		usable: catalog.filter((model) => ids.includes(model.id)),
		unusable: ids.filter((id) => !catalog.some((model) => model.id === id)),
	}
}

/**
 * Asks `provider`, with its key, which models it offers, or why it didn't say. A provider without a
 * model list gets pi-ai's catalog of its kind. Throws only when the provider can't be reached.
 */
export function providerModels(
	provider: ModelProviderDescription,
	key: string,
	fetchFromHost: typeof fetch,
	abortSignal: AbortSignal,
): Promise<ProviderModels> {
	// A provider that ignores the signal, or never finishes its answer, can't hold up a stop.
	return untilAborted(askedModels(provider, key, fetchFromHost, abortSignal), abortSignal)
}
