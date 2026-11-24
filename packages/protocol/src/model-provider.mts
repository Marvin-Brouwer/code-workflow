import { z } from 'zod'

/** Names a model provider in the app's config, such as `anthropic` or `work-openrouter`. */
export const ProviderName = z.string().regex(/^[a-z0-9][\w-]{0,63}$/, 'Use 1 to 64 lowercase letters, digits, _ or -.')

/**
 * One model provider the app's config declares: which pi-ai provider it is, and where it is, when
 * that's a proxy or a compatible server. Only its key is per user, in the gateway's credential store.
 */
export const ModelProviderDescription = z.object({
	name: ProviderName,
	/** The pi-ai provider it is, such as `anthropic`, `openai` or `openrouter`: its API, its base URL and its models. */
	kind: z.string().min(1),
	/** Overrides the kind's base URL, for a proxy or a compatible server. */
	baseUrl: z.url().optional(),
})
export type ModelProviderDescription = z.infer<typeof ModelProviderDescription>

/** An agent's model ids, in the order they're tried: the first one a provider with a key offers is used. */
export const ModelChoice = z.array(z.string().min(1)).min(1)
export type ModelChoice = z.infer<typeof ModelChoice>
