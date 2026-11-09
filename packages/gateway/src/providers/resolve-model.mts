import type { Api, Model } from '@earendil-works/pi-ai'
import { modelsOfKind } from './model-apis.mts'
import type { ProviderSetting } from './provider-settings.mts'

/** A model id resolved to the provider that serves it, with pi-ai's description of the model. */
export interface ModelChoice {
	readonly provider: ProviderSetting
	readonly model: Model<Api>
}

/**
 * Model first: the first provider in the user's order that offers `modelId`
 * ([design section 7](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#model-providers)).
 * Throws, naming what is offered, when none does.
 */
export function resolveModel(providers: readonly ProviderSetting[], modelId: string): ModelChoice {
	for (const provider of providers) {
		const model = modelsOfKind(provider.kind)?.find((offered) => offered.id === modelId)
		if (model !== undefined) return { provider, model }
	}
	if (providers.length === 0)
		throw new Error(`No model providers are set up, so nothing serves model ${modelId}. Add one with \`mesh-flow provider add\`.`)
	throw new Error(`None of the providers (${providers.map((provider) => provider.name).join(', ')}) offers model ${modelId}.`)
}

/** The provider called `name`, offering `modelId`: what a model call names. Throws when it's not so. */
export function chosenModel(providers: readonly ProviderSetting[], name: string, modelId: string): ModelChoice {
	const provider = providers.find((known) => known.name === name)
	if (provider === undefined) throw new Error(`There is no provider ${name}.`)
	const model = modelsOfKind(provider.kind)?.find((offered) => offered.id === modelId)
	if (model === undefined) throw new Error(`Provider ${name} doesn't offer model ${modelId}.`)
	return { provider, model }
}
