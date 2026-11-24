import { openAiCompatibleKind, type ModelConfiguration, type ModelProviderDescription } from '@mesh-flow/protocol'
import { modelsOfKind } from './model-apis.mts'
import { offeredModel } from './offering-provider.mts'

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
export function undeclaredModels(providers: readonly ModelProviderDescription[], agentModels: readonly ModelConfiguration[]): string[] {
	const kindProblems = providers
		.filter((provider) => !isSendable(provider))
		.map(
			(provider) =>
				`The gateway can't send model calls for provider kind ${provider.kind} (provider ${provider.name}). See \`mesh-flow provider kinds\`.`,
		)
	const unoffered = [...new Set(agentModels.flat())]
		.filter((modelId) => !providers.some((provider) => offeredModel(provider, modelId) !== undefined))
		.map((modelId) => notOfferedMessage(providers, modelId))
	return [...kindProblems, ...unoffered]
}

/** Says that no provider of the app's config offers `modelId`: a change to the config in git, not a setting. */
export function notOfferedMessage(providers: readonly ModelProviderDescription[], modelId: string): string {
	if (providers.length === 0)
		return `Model ${modelId} isn't offered by any provider in the config: it declares none. Add one to \`modelProviders\` in \`defineMeshFlow\`.`
	return `Model ${modelId} isn't offered by any provider in the config (${providers.map((provider) => provider.name).join(', ')}).`
}
