import { openAiCompatibleKind, type ModelProviderDescription } from '@mesh-flow/protocol'
import { modelsOfKind } from './model-apis.mts'

/** Whether the gateway can send model calls for the kind of `provider`. */
export function isSendable(provider: ModelProviderDescription): boolean {
	return provider.kind === openAiCompatibleKind || (modelsOfKind(provider.kind)?.length ?? 0) > 0
}

/** Says the gateway can't send model calls for `provider`'s kind. */
export function unsendableKindMessage(provider: ModelProviderDescription): string {
	return `The gateway can't send model calls for provider kind ${provider.kind} (provider ${provider.name}). See \`mesh-flow provider kinds\`.`
}
