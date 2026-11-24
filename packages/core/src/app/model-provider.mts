import type { KnownProvider } from '@earendil-works/pi-ai'
import { ModelProviderDescription } from '@mesh-flow/protocol'

/** What {@link modelProvider} takes besides the kind. */
export interface ModelProviderOptions {
	/** The provider's name, which its key is set under. Default: the kind. Two providers can't share one. */
	readonly name?: string
	/** Another base URL than the kind's, for a proxy or a compatible server. */
	readonly baseUrl?: string
}

/** One model provider of the app, as `defineMeshFlow` lists them. */
export type ModelProvider = ModelProviderDescription

/**
 * A model provider the app's agents may run on: a pi-ai provider kind, and where it is when that's
 * a proxy or a compatible server. This is team policy, reviewed in git: each user only sets its key,
 * with `mesh-flow provider key <name>` or in the UI, and can leave a provider without one.
 *
 * ```ts
 * export default defineMeshFlow({
 * 	sandbox: image({
 * 		name: 'node:26-slim',
 * 	}),
 * 	// A model goes to the first provider here that offers it and has a key.
 * 	modelProviders: [
 * 		modelProvider('anthropic'),
 * 		modelProvider('openrouter', {
 * 			name: 'work-openrouter',
 * 			baseUrl: 'https://llm-proxy.example.com/api/v1',
 * 		}),
 * 	],
 * 	workflows: [
 * 		userTrigger(develop),
 * 	],
 * })
 * ```
 */
export function modelProvider(kind: KnownProvider, options: ModelProviderOptions = {}): ModelProvider {
	return Object.freeze(
		ModelProviderDescription.parse({
			name: options.name ?? kind,
			kind,
			...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		}),
	)
}
