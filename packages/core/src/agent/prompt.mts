import type { PromptValues } from '../render/prompt-values.mts'

export const promptParts: unique symbol = Symbol.for('mesh-flow.prompt')

/** A template with interpolated values, for an agent's system prompt. The values are checked like a loop's. */
export interface Prompt {
	readonly [promptParts]: { readonly strings: readonly string[]; readonly values: readonly unknown[] }
}

/**
 * A prompt for an agent's `system`, written like a loop's template. Tools interpolated here are
 * there in every loop of that agent.
 *
 * ```ts
 * export const planner = agent({
 * 	model: 'claude-opus-5-5',
 * 	system: prompt`You plan development work. When anything is unclear, ${requestUserInput} instead of guessing.`,
 * })
 * ```
 */
export function prompt<Values extends readonly unknown[]>(strings: TemplateStringsArray, ...values: Values & PromptValues<Values>): Prompt {
	return Object.freeze({ [promptParts]: { strings: [...strings], values } })
}

/** Whether a value is a prompt made by {@link prompt}. */
export function isPrompt(value: unknown): value is Prompt {
	return typeof value === 'object' && value !== null && promptParts in value
}
