import type { Check } from './check'
import type { Exit } from './exits'
import type { Tool } from './tool'

export interface Agent {
	/**
	 * Runs the agent until it calls one of the exit tools interpolated in the prompt.
	 * The result type is inferred from those exits; without exits, it's the agent's final text.
	 * Interpolated tools are registered for this loop; other values are rendered into the prompt.
	 * Backed by a Pi Durable session keyed by its call site.
	 */
	loop<Values extends readonly unknown[]>(prompt: TemplateStringsArray, ...values: Values): Promise<ResultOf<Values>>

	/** Exposes this agent as a tool for another agent, e.g. a reviewer asking a developer for a change. */
	as(name: string, options: { in?: unknown; verify?: readonly Check[] }): Tool
}

export interface Prompt {
	readonly kind: 'prompt'
}

export function agent(options: { model: string; reasoning?: 'low' | 'medium' | 'high'; system?: Prompt }): Agent

/** A prompt with interpolated tools, for an agent's system prompt. */
export function prompt(strings: TemplateStringsArray, ...values: readonly unknown[]): Prompt

/** Lets an agent ask the user a question mid-loop. */
export const requestUserInput: Tool

type ResultOf<Values extends readonly unknown[]> = Extract<Values[number], Exit<unknown>> extends Exit<infer T> ? T : string
