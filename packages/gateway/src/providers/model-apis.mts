import type { Api, Model } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelProviderDescription } from '@mesh-flow/protocol'

/** How the gateway sends requests of one model API: the paths a model call may take, and how the key goes along. */
interface ModelApi {
	/** Paths below the base URL that make a model request. Anything else is refused: the key is for model calls only. */
	readonly paths: readonly string[]
	/** The headers that carry the key. */
	readonly credential: (key: string) => Record<string, string>
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

/**
 * The model APIs the gateway can send with an API key. Each provider SDK in the sandbox makes its
 * native request; the gateway only checks the path and adds the key, so provider features
 * (thinking, caching, beta headers) stay intact.
 */
const modelApis: Readonly<Partial<Record<Api, ModelApi>>> = {
	'anthropic-messages': { paths: ['/v1/messages'], credential: (key) => ({ 'x-api-key': key }) },
	'openai-completions': { paths: ['/chat/completions'], credential: bearer },
	'openai-responses': { paths: ['/responses'], credential: bearer },
}

/** How to send requests of `api`, or `undefined` when the gateway can't. */
export function modelApi(api: Api): ModelApi | undefined {
	return modelApis[api]
}

let catalog: ReadonlyMap<string, readonly Model<Api>[]> | undefined

/**
 * The models a kind of provider offers that the gateway can send, from pi-ai's catalog, such as
 * those of `anthropic`. `undefined` for a kind pi-ai doesn't know.
 */
export function modelsOfKind(kind: string): readonly Model<Api>[] | undefined {
	return catalogOfKinds().get(kind)
}

/** pi-ai's models the gateway can send, by provider kind. */
function catalogOfKinds(): ReadonlyMap<string, readonly Model<Api>[]> {
	catalog ??= new Map(builtinProviders().map((provider) => [provider.id, provider.getModels().filter((model) => modelApis[model.api])]))
	return catalog
}

/** What a model of a compatible server gets when pi-ai's catalog doesn't know its id. */
const compatibleDefaults = { contextWindow: 128_000, maxTokens: 16_384, reasoning: false }

/**
 * Model `modelId` of the compatible server `provider`, on OpenAI's Chat Completions API with no
 * price. The server only lists ids, so its context window, answer size and whether it reasons come
 * from pi-ai's catalog when a kind there knows the id, else from defaults.
 */
export function compatibleModel(provider: ModelProviderDescription, modelId: string): Model<Api> {
	const known = [...catalogOfKinds().values()].flat().find((model) => model.id === modelId) ?? compatibleDefaults
	return {
		id: modelId,
		name: modelId,
		api: 'openai-completions',
		provider: provider.name,
		baseUrl: provider.baseUrl ?? '',
		contextWindow: known.contextWindow,
		maxTokens: known.maxTokens,
		reasoning: known.reasoning,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}
}

/** The kinds of provider the gateway can send for, with how many models each offers. */
export function knownKinds(): { readonly kind: string; readonly models: number }[] {
	return builtinProviders()
		.map((provider) => ({ kind: provider.id, models: modelsOfKind(provider.id)?.length ?? 0 }))
		.filter((known) => known.models > 0)
}
