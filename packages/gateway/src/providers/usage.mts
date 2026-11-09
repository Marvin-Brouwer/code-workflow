import type { Api, Model } from '@earendil-works/pi-ai'
import { z } from 'zod'

/** What a run used of one model, counted at the gateway. Cost in US dollars, from pi-ai's prices. */
export const ModelUsage = z.object({
	requests: z.int().nonnegative(),
	inputTokens: z.int().nonnegative(),
	outputTokens: z.int().nonnegative(),
	cacheReadTokens: z.int().nonnegative(),
	cacheWriteTokens: z.int().nonnegative(),
	costUsd: z.number().nonnegative(),
})
export type ModelUsage = z.infer<typeof ModelUsage>

/** A run's usage, by model id. */
export const RunUsage = z.record(z.string(), ModelUsage)
export type RunUsage = z.infer<typeof RunUsage>

type Tokens = Omit<ModelUsage, 'requests' | 'costUsd'>

const noTokens: Tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** pi-ai prices tokens per million. */
const tokensPerPrice = 1_000_000

/**
 * What one model response used, read from the provider's own usage fields: Anthropic's
 * `input_tokens` and `output_tokens`, OpenAI's `prompt_tokens` and `completion_tokens` or
 * `input_tokens` and `output_tokens`. A stream reports usage in several events; its counts only
 * grow, so the largest of each is the total.
 */
export function usageOf(body: string, model: Model<Api>): ModelUsage {
	const tokens = { ...noTokens }
	for (const payload of payloadsOf(body)) {
		for (const usage of usagesIn(payload)) {
			// OpenAI counts cached tokens in the input as well; Anthropic doesn't.
			const cached = usage.cache_read_input_tokens === undefined ? count(cachedTokens(usage)) : 0
			tokens.inputTokens = Math.max(tokens.inputTokens, count(usage.input_tokens ?? usage.prompt_tokens) - cached)
			tokens.outputTokens = Math.max(tokens.outputTokens, count(usage.output_tokens ?? usage.completion_tokens))
			tokens.cacheReadTokens = Math.max(tokens.cacheReadTokens, count(usage.cache_read_input_tokens) + cached)
			tokens.cacheWriteTokens = Math.max(tokens.cacheWriteTokens, count(usage.cache_creation_input_tokens))
		}
	}
	const { cost } = model
	const costUsd =
		(tokens.inputTokens * cost.input +
			tokens.outputTokens * cost.output +
			tokens.cacheReadTokens * cost.cacheRead +
			tokens.cacheWriteTokens * cost.cacheWrite) /
		tokensPerPrice
	return { requests: 1, ...tokens, costUsd }
}

/** Adds one response's usage to a run's. */
export function addUsage(run: RunUsage, modelId: string, used: ModelUsage): RunUsage {
	const known = run[modelId]
	if (known === undefined) return { ...run, [modelId]: used }
	return {
		...run,
		[modelId]: {
			requests: known.requests + used.requests,
			inputTokens: known.inputTokens + used.inputTokens,
			outputTokens: known.outputTokens + used.outputTokens,
			cacheReadTokens: known.cacheReadTokens + used.cacheReadTokens,
			cacheWriteTokens: known.cacheWriteTokens + used.cacheWriteTokens,
			costUsd: known.costUsd + used.costUsd,
		},
	}
}

const UsageFields = z.looseObject({
	input_tokens: z.number().optional(),
	output_tokens: z.number().optional(),
	prompt_tokens: z.number().optional(),
	completion_tokens: z.number().optional(),
	cache_read_input_tokens: z.number().optional(),
	cache_creation_input_tokens: z.number().optional(),
	prompt_tokens_details: z.looseObject({ cached_tokens: z.number().optional() }).optional(),
	input_tokens_details: z.looseObject({ cached_tokens: z.number().optional() }).optional(),
})
type UsageFields = z.infer<typeof UsageFields>

/** The JSON payloads of a response: the body itself, or each `data:` line of a server-sent event stream. */
function payloadsOf(body: string): unknown[] {
	const whole = parsed(body)
	if (whole !== undefined) return [whole]
	return body.split('\n').flatMap((line) => {
		if (!line.startsWith('data:')) return []
		const payload = parsed(line.slice('data:'.length).trim())
		return payload === undefined ? [] : [payload]
	})
}

/** Usage objects where the providers put them: at the top, in `message` (Anthropic's `message_start`) or in `response` (OpenAI's `response.completed`). */
function usagesIn(payload: unknown): UsageFields[] {
	if (typeof payload !== 'object' || payload === null) return []
	const candidates = [payload, 'message' in payload ? payload.message : undefined, 'response' in payload ? payload.response : undefined]
	return candidates.flatMap((candidate) => {
		if (typeof candidate !== 'object' || candidate === null || !('usage' in candidate)) return []
		const usage = UsageFields.safeParse(candidate.usage)
		return usage.success ? [usage.data] : []
	})
}

function cachedTokens(usage: UsageFields): number | undefined {
	return usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens
}

function count(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) || value < 0 ? 0 : Math.round(value)
}

function parsed(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text)
		return value
	} catch {
		return undefined
	}
}
