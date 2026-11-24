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
 * A provider of one kind, before it's made: listed as it is in `modelProviders`, it gets its
 * defaults, and called with options, it gets a name or a base URL of its own.
 */
export type ModelProviderFactory = (options?: ModelProviderOptions) => ModelProvider

/**
 * A model provider of any pi-ai provider kind, for a kind without a factory of its own below, and
 * where it is when that's a proxy or a compatible server. This is team policy, reviewed in git:
 * each user only sets its key, with `mesh-flow provider key <name>` or in the UI, and can leave a
 * provider without one.
 *
 * ```ts
 * modelProviders: [
 * 	modelProvider('moonshotai'),
 * ]
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

/** The factory of providers of `kind`. */
function factoryOf(kind: KnownProvider): ModelProviderFactory {
	return (options) => modelProvider(kind, options)
}

/** Anthropic's API, for Claude models. Named `anthropic` by default. */
export const anthropicClaude = factoryOf('anthropic')

/** OpenAI's API. Named `openai` by default. */
export const openAi = factoryOf('openai')

/** OpenRouter, which serves many vendors' models under one key. Named `openrouter` by default. */
export const openRouter = factoryOf('openrouter')

/** Groq. Named `groq` by default. */
export const groq = factoryOf('groq')

/** DeepSeek's API. Named `deepseek` by default. */
export const deepSeek = factoryOf('deepseek')

/** xAI's API, for Grok models. Named `xai` by default. */
export const xAi = factoryOf('xai')

/** The model providers a list in `modelProviders` names, each made: a factory listed as it is gets its defaults. */
export function madeProviders(listed: readonly (ModelProvider | ModelProviderFactory)[]): ModelProvider[] {
	return listed.map((entry) => (typeof entry === 'function' ? entry() : entry))
}
