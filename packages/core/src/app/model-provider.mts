import type { KnownProvider } from '@earendil-works/pi-ai'
import { ModelProviderDescription, openAiCompatibleKind } from '@mesh-flow/protocol'

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

/**
 * GitHub Copilot. Named `github-copilot` by default. It needs a GitHub sign-in exchanged for a
 * Copilot token, which the gateway doesn't do yet: until it does, a key set for it doesn't work.
 */
export const githubCopilot = factoryOf('github-copilot')

/** A model a compatible server offers, as {@link openAiCompatible} takes it. */
export interface CompatibleModelOptions {
	/** The model id the server takes, and agents name. */
	readonly id: string
	/** How many tokens the model's context holds: a loop that outgrows it fails. Default: 128,000. */
	readonly contextWindow?: number
	/** How many tokens one answer may have. Default: 16,384. */
	readonly maxTokens?: number
	/** Whether the model thinks before it answers, so an agent's `reasoning` applies. Default: no. */
	readonly reasoning?: boolean
}

/** What {@link openAiCompatible} takes. */
export interface OpenAiCompatibleOptions {
	/** The provider's name, which its key is set under. */
	readonly name: string
	/** Where the server's API is, such as `https://litellm.example.com/v1`. */
	readonly baseUrl: string
	/** The models it offers. pi-ai doesn't know them, so the config says what they are. */
	readonly models: readonly [CompatibleModelOptions, ...CompatibleModelOptions[]]
}

const defaultContextWindow = 128_000
const defaultMaxTokens = 16_384

/**
 * A server that speaks OpenAI's Chat Completions API with models of its own, such as a LiteLLM
 * proxy, vLLM or Ollama. Its usage is counted, but without a price.
 *
 * ```ts
 * modelProviders: [
 * 	openAiCompatible({
 * 		name: 'team-litellm',
 * 		baseUrl: 'https://litellm.example.com/v1',
 * 		models: [
 * 			{ id: 'claude-sonnet-5-5', contextWindow: 200_000, reasoning: true },
 * 		],
 * 	}),
 * ]
 * ```
 */
export function openAiCompatible(options: OpenAiCompatibleOptions): ModelProvider {
	return Object.freeze(
		ModelProviderDescription.parse({
			name: options.name,
			kind: openAiCompatibleKind,
			baseUrl: options.baseUrl,
			models: options.models.map((model) => ({
				id: model.id,
				contextWindow: model.contextWindow ?? defaultContextWindow,
				maxTokens: model.maxTokens ?? defaultMaxTokens,
				reasoning: model.reasoning ?? false,
			})),
		}),
	)
}

/** The model providers a list in `modelProviders` names, each made: a factory listed as it is gets its defaults. */
export function madeProviders(listed: readonly (ModelProvider | ModelProviderFactory)[]): ModelProvider[] {
	return listed.map((entry) => (typeof entry === 'function' ? entry() : entry))
}
