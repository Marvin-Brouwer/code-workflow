import { z } from 'zod'

/** Names a model provider in the app's config, such as `anthropic` or `work-openrouter`. */
export const ProviderName = z.string().regex(/^[a-z0-9][\w-]{0,63}$/, 'Use 1 to 64 lowercase letters, digits, _ or -.')

/** The kind of a server that speaks OpenAI's Chat Completions API with models of its own, such as a LiteLLM proxy. */
export const openAiCompatibleKind = 'openai-compatible'

/**
 * A model a compatible server offers, as the gateway hands it to the sandbox: the server lists the
 * id, and the rest comes from pi-ai's catalog when it knows the id, else from defaults.
 */
export const CompatibleModel = z.object({
	/** The model id the server takes, and agents name. */
	id: z.string().min(1),
	/** How many tokens the model's context holds: a loop that outgrows it fails. */
	contextWindow: z.int().positive(),
	/** How many tokens one answer may have. */
	maxTokens: z.int().positive(),
	/** Whether the model thinks before it answers, so an agent's `reasoning` applies. */
	reasoning: z.boolean(),
})
export type CompatibleModel = z.infer<typeof CompatibleModel>

/**
 * One model provider the app's config declares: which pi-ai provider it is, and where it is, when
 * that's a proxy or a compatible server. Only its key is per user, in the gateway's credential store.
 * A provider of kind {@link openAiCompatibleKind} has a base URL; the server lists its models.
 */
export const ModelProviderDescription = z
	.object({
		name: ProviderName,
		/** The pi-ai provider it is, such as `anthropic`, `openai` or `openrouter`: its API, its base URL and its models. */
		kind: z.string().min(1),
		/** Overrides the kind's base URL, for a proxy or a compatible server. */
		baseUrl: z.url().optional(),
	})
	.refine((provider) => provider.kind !== openAiCompatibleKind || provider.baseUrl !== undefined, {
		message: `A provider of kind ${openAiCompatibleKind} needs a base URL.`,
	})
export type ModelProviderDescription = z.infer<typeof ModelProviderDescription>

/** An agent's model ids, in the order they're tried: the first one a provider with a key offers is used. */
export const ModelConfiguration = z.array(z.string().min(1)).min(1)
export type ModelConfiguration = z.infer<typeof ModelConfiguration>
