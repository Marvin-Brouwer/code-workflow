import type { Api, Model } from '@earendil-works/pi-ai'
import { openAiCompatibleKind, type ModelProviderDescription } from '@mesh-flow/protocol'
import { compatibleModel, modelsOfKind } from './model-apis.mts'

/** A model id resolved to the provider that offers it, with pi-ai's description of the model. */
export interface OfferedModel {
	readonly provider: ModelProviderDescription
	readonly model: Model<Api>
}

/**
 * The models providers said they offer their keys, by provider name. A provider missing here wasn't
 * asked, or couldn't say: such as one without a key, or at build time. Then its kind's models in
 * pi-ai's catalog stand in, and a compatible server may offer any model.
 */
export type ServedModels = ReadonlyMap<string, readonly Model<Api>[]>

const notAsked: ServedModels = new Map()

/**
 * Model first: the agent's first model id that a provider with a key offers, on the first such
 * provider in the app's order
 * ([design section 7](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#model-providers)).
 * `undefined` when none does.
 */
export function offeringProvider(
	providers: readonly ModelProviderDescription[],
	modelIds: readonly string[],
	hasKey: (provider: string) => boolean,
	served: ServedModels = notAsked,
): OfferedModel | undefined {
	for (const modelId of modelIds) {
		for (const provider of providers) {
			if (!hasKey(provider.name)) continue
			const model = offeredModel(provider, modelId, served)
			if (model !== undefined) return { provider, model }
		}
	}
	return undefined
}

/**
 * The model `modelId` as `provider` offers it, or `undefined` when it doesn't: as the provider
 * listed it in `served`, else from its kind in pi-ai's catalog.
 */
export function offeredModel(provider: ModelProviderDescription, modelId: string, served: ServedModels = notAsked): Model<Api> | undefined {
	const listed = served.get(provider.name)
	if (listed !== undefined) return listed.find((offered) => offered.id === modelId)
	if (provider.kind === openAiCompatibleKind) return compatibleModel(provider, modelId)
	return modelsOfKind(provider.kind)?.find((offered) => offered.id === modelId)
}

/** The provider called `name`, offering `modelId`: what a model call names. Throws when it's not so. */
export function chosenModel(providers: readonly ModelProviderDescription[], name: string, modelId: string): OfferedModel {
	const provider = providers.find((known) => known.name === name)
	if (provider === undefined) throw new Error(`The app has no provider ${name}.`)
	const model = offeredModel(provider, modelId)
	if (model === undefined) throw new Error(`Provider ${name} doesn't offer model ${modelId}.`)
	return { provider, model }
}
