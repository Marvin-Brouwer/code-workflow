import type { Api, Model } from '@earendil-works/pi-ai'
import { openAiCompatibleKind, type ModelProviderDescription } from '@mesh-flow/protocol'
import { compatibleModel, modelsOfKind } from './model-apis.mts'

/** A model id resolved to the provider that serves it, with pi-ai's description of the model. */
export interface ModelChoice {
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
): ModelChoice | undefined {
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
export function chosenModel(providers: readonly ModelProviderDescription[], name: string, modelId: string): ModelChoice {
	const provider = providers.find((known) => known.name === name)
	if (provider === undefined) throw new Error(`The app has no provider ${name}.`)
	const model = offeredModel(provider, modelId)
	if (model === undefined) throw new Error(`Provider ${name} doesn't offer model ${modelId}.`)
	return { provider, model }
}

/** Whether the gateway can send model calls for the kind of `provider`. */
function isSendable(provider: ModelProviderDescription): boolean {
	return provider.kind === openAiCompatibleKind || (modelsOfKind(provider.kind)?.length ?? 0) > 0
}

/**
 * What the app's config gets wrong about its models, each a line: a provider kind the gateway can't
 * send for, or an agent's model no declared provider offers. Empty when every agent has a model
 * that a declared provider offers. A compatible server isn't asked here, so it counts as offering
 * every model. `mesh-flow build` fails with these.
 */
export function undeclaredModels(providers: readonly ModelProviderDescription[], agentModels: readonly (readonly string[])[]): string[] {
	const unknownKinds = providers
		.filter((provider) => !isSendable(provider))
		.map(
			(provider) =>
				`The gateway can't send model calls for provider kind ${provider.kind} (provider ${provider.name}). See \`mesh-flow provider kinds\`.`,
		)
	const unoffered = [...new Set(agentModels.flat())]
		.filter((modelId) => !providers.some((provider) => offeredModel(provider, modelId) !== undefined))
		.map((modelId) => notOfferedMessage(providers, modelId))
	return [...unknownKinds, ...unoffered]
}

/** Says that no provider of the app's config offers `modelId`: a change to the config in git, not a setting. */
export function notOfferedMessage(providers: readonly ModelProviderDescription[], modelId: string): string {
	if (providers.length === 0)
		return `Model ${modelId} isn't offered by any provider in the config: it declares none. Add one to \`modelProviders\` in \`defineMeshFlow\`.`
	return `Model ${modelId} isn't offered by any provider in the config (${providers.map((provider) => provider.name).join(', ')}).`
}
