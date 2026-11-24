import type { Api, AssistantMessageEventStream, Model, ProviderRequestOptions } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai/models'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelRef } from '@earendil-works/pi-durable'
import { ModelResponse, ResolvedModel, type CompatibleModel } from '@mesh-flow/protocol'
import type { ModelSource } from '../loop/model-source.mts'
import type { GatewayClient } from './gateway-client.mts'

/**
 * What the provider SDKs get as an API key in the sandbox. It means nothing: the gateway drops
 * every credential header a model call comes with and adds the real key on the host.
 */
const noKey = 'mesh-flow-gateway-adds-the-key'

/** Who the key comes from, as pi-ai's auth names it. */
const keySource = 'mesh-flow gateway'

/**
 * The run's models, through the gateway. An agent's model ids are resolved on the host, model first,
 * to one of the providers the app's config declares that has a key. The provider's SDK runs here,
 * as pi-ai always runs it, and makes the provider's own request, but its `fetch` hands the request
 * to the gateway, which sends it with the key. Nothing in the sandbox holds a key.
 */
export function gatewayModels(gateway: GatewayClient): ModelSource {
	const models = createModels()
	const resolved = new Map<string, Promise<ModelRef>>()
	// A compatible server's models, by provider: pi-ai doesn't know them, so its provider is made again with each one resolved on it.
	const compatibleModels = new Map<string, CompatibleModel[]>()
	const resolve = async (modelIds: readonly string[], abortSignal: AbortSignal): Promise<ModelRef> => {
		const choice = ResolvedModel.parse(await gateway.call(gateway.run, { type: 'resolve-model', models: [...modelIds] }, abortSignal))
		if (choice.compatible === undefined) {
			if (models.getProvider(choice.provider) === undefined)
				models.setProvider(gatewayProvider(choice, builtinProviderOf(choice.kind), gateway))
			return { provider: choice.provider, modelId: choice.model }
		}
		const known = compatibleModels.get(choice.provider) ?? []
		const offered = known.some((model) => model.id === choice.model) ? known : [...known, choice.compatible.model]
		compatibleModels.set(choice.provider, offered)
		models.setProvider(gatewayProvider(choice, compatibleProvider(choice.kind, choice.compatible.baseUrl, offered), gateway))
		return { provider: choice.provider, modelId: choice.model }
	}
	return {
		models,
		resolve(modelIds, abortSignal) {
			const key = JSON.stringify(modelIds)
			const known = resolved.get(key)
			if (known !== undefined) return known
			const resolving = resolve(modelIds, abortSignal)
			resolved.set(key, resolving)
			// A failed resolve is tried again by the next loop: the user may have set a key since.
			resolving.catch(() => resolved.delete(key))
			return resolving
		},
	}
}

/** One of the app's providers, as the sandbox sees it: pi-ai's provider of its kind, with a `fetch` that goes through the gateway. */
function gatewayProvider(choice: ResolvedModel, inner: Provider, gateway: GatewayClient): Provider {
	const asInner = <TApi extends Api>(model: Model<TApi>): Model<TApi> => ({ ...model, provider: inner.id })
	const options = <Options extends ProviderRequestOptions<never>>(model: Model<Api>, given: Options | undefined): Options =>
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options are the caller's, with the key and fetch replaced
		({ ...given, apiKey: noKey, fetch: fetchThroughGateway(choice.provider, model, gateway) }) as Options
	return {
		id: choice.provider,
		name: choice.provider,
		...(inner.baseUrl === undefined ? {} : { baseUrl: inner.baseUrl }),
		...(inner.headers === undefined ? {} : { headers: inner.headers }),
		auth: {
			apiKey: { name: keySource, resolve: () => Promise.resolve({ auth: { apiKey: noKey }, source: keySource }) },
		},
		getModels: () => inner.getModels().map((model) => ({ ...model, provider: choice.provider })),
		stream: (model, context, given): AssistantMessageEventStream => inner.stream(asInner(model), context, options(model, given)),
		streamSimple: (model, context, given): AssistantMessageEventStream =>
			inner.streamSimple(asInner(model), context, options(model, given)),
	}
}

/** What a compatible server's models cost here: nothing is known, so they're counted without a price. */
const unpriced = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** A compatible server, which pi-ai doesn't know: OpenAI's Chat Completions API at its base URL, with the models resolved on it so far. */
function compatibleProvider(kind: string, baseUrl: string, offered: readonly CompatibleModel[]): Provider {
	return createProvider({
		id: kind,
		baseUrl,
		auth: { apiKey: { name: keySource, resolve: () => Promise.resolve({ auth: { apiKey: noKey }, source: keySource }) } },
		models: offered.map((model) => ({
			...model,
			name: model.id,
			api: 'openai-completions',
			provider: kind,
			baseUrl,
			input: ['text'],
			cost: unpriced,
		})),
		api: openAICompletionsApi(),
	})
}

/** pi-ai's provider of `kind`. */
function builtinProviderOf(kind: string): Provider {
	const builtin = builtinProviders().find((provider) => provider.id === kind)
	if (builtin === undefined) throw new Error(`pi-ai in the sandbox doesn't know provider kind ${kind}.`)
	return builtin
}

/**
 * A `fetch` that sends a model request to the gateway instead of the provider: the path below the
 * model's base URL, the headers and the body. It answers with the provider's whole response.
 */
function fetchThroughGateway(provider: string, model: Model<Api>, gateway: GatewayClient): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init)
		if (request.method !== 'POST') throw new Error(`The gateway only sends model requests, which are POSTs, not a ${request.method}.`)
		const base = model.baseUrl.replace(/\/+$/, '')
		if (!request.url.startsWith(base)) throw new Error(`A model request went to ${request.url}, not below ${base}.`)
		const headers: Record<string, string> = {}
		request.headers.forEach((value, name) => {
			headers[name] = value
		})
		const abortSignal = init?.signal ?? request.signal
		const result = await gateway.call(
			gateway.run,
			{
				type: 'model',
				request: { provider, model: model.id, path: request.url.slice(base.length), method: 'POST', headers, body: await request.text() },
			},
			abortSignal,
		)
		const response = ModelResponse.parse(result)
		return new Response(response.body, { status: response.status, headers: response.headers })
	}
}
