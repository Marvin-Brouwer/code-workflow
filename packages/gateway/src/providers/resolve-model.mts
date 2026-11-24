import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelProviderDescription } from '@mesh-flow/protocol'
import { modelsOfProvider } from './model-apis.mts'

/** A model id resolved to the provider that serves it, with pi-ai's description of the model. */
export interface ModelChoice {
	readonly provider: ModelProviderDescription
	readonly model: Model<Api>
}

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
): ModelChoice | undefined {
	for (const modelId of modelIds) {
		for (const provider of providers) {
			if (!hasKey(provider.name)) continue
			const model = offeredModel(provider, modelId)
			if (model !== undefined) return { provider, model }
		}
	}
	return undefined
}

/** The model `modelId` as `provider` offers it, or `undefined` when its kind doesn't. */
export function offeredModel(provider: ModelProviderDescription, modelId: string): Model<Api> | undefined {
	return modelsOfProvider(provider)?.find((offered) => offered.id === modelId)
}

/** The provider called `name`, offering `modelId`: what a model call names. Throws when it's not so. */
export function chosenModel(providers: readonly ModelProviderDescription[], name: string, modelId: string): ModelChoice {
	const provider = providers.find((known) => known.name === name)
	if (provider === undefined) throw new Error(`The app has no provider ${name}.`)
	const model = offeredModel(provider, modelId)
	if (model === undefined) throw new Error(`Provider ${name} doesn't offer model ${modelId}.`)
	return { provider, model }
}

/**
 * What the app's config gets wrong about its models, each a line: a provider kind the gateway can't
 * send for, or an agent's model no declared provider offers. Empty when every agent has a model
 * that a declared provider offers. `mesh-flow build` fails with these.
 */
export function undeclaredModels(providers: readonly ModelProviderDescription[], agentModels: readonly (readonly string[])[]): string[] {
	const unknownKinds = providers
		.filter((provider) => (modelsOfProvider(provider)?.length ?? 0) === 0)
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
