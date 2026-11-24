import { z } from 'zod'
import type { Check } from '../check/check.mts'
import type { ResultOf } from '../exits/result-of.mts'
import { verify } from '../exits/verify.mts'
import { runLoop } from '../loop/run-loop.mts'
import type { PromptValues } from '../render/prompt-values.mts'
import { callSite, callSiteText } from '../run/call-site.mts'
import { tool, type Tool } from '../tool/tool.mts'
import { modelIdsOf, type AgentModel } from './agent-model.mts'
import type { Prompt } from './prompt.mts'

export interface AgentOptions {
	/** The model the agent runs on, or several to fall back on. The app's providers resolve it, model first. */
	readonly model: AgentModel
	/** How much the model thinks before it answers. The model's default without it. */
	readonly reasoning?: 'low' | 'medium' | 'high'
	/** The system prompt. Tools interpolated in it are there in every loop of this agent. */
	readonly system?: Prompt
}

export interface AsToolOptions {
	/** What the agent works on, such as a repository; interpolated into its task. */
	readonly in?: unknown
	/** Checks its work has to pass before the tool returns. */
	readonly verify?: readonly Check[]
}

export interface Agent {
	/** The model the agent runs on, or several in the order they're tried. */
	readonly model: AgentModel
	/**
	 * Runs the agent until it calls one of the exits interpolated in the template, and resolves to
	 * the exit's result (see `ResultOf`). Without exits, it resolves to the agent's final text.
	 * Interpolated tools are registered for this loop; other values render into the prompt.
	 *
	 * ```ts
	 * const plan = await planner.loop`Plan ${story}. Propose the plan with ${propose(Plan)}.`
	 * ```
	 *
	 * The loop rejects when the agent calls `fail`, a tool throws, a `limit` runs out, `verify`
	 * rejects too often, the model fails or hits its context limit, or the run is stopped.
	 */
	loop<Values extends readonly unknown[]>(
		template: TemplateStringsArray,
		...values: Values & PromptValues<Values>
	): Promise<ResultOf<Values>>
	/**
	 * This agent as a tool for another agent: the other agent describes a task, this one does it in
	 * a loop of its own. With `verify`, the work has to pass those checks before the tool returns.
	 *
	 * ```ts
	 * await reviewer.loop`... Ask ${developer.as('changeCode', { in: repository, verify: [tests(repository)] })} for code changes.`
	 * ```
	 */
	as(name: string, options?: AsToolOptions): Tool<{ task: string }, string>
}

/** The model ids of every agent made in this process, by their JSON text, so each list is there once. */
const defined = new Map<string, readonly string[]>()

/**
 * The model ids of every agent made in this process, each agent's in the order they're tried: what
 * the app's runs need a provider for.
 */
export function definedModels(): string[][] {
	return [...defined.entries()].toSorted(([first], [second]) => first.localeCompare(second)).map(([, models]) => [...models])
}

/**
 * Defines an agent. Agents belong to the workflow repository (`agents.mts`), not to packages:
 * models and conventions are team specific.
 *
 * ```ts
 * export const developer = agent({
 * 	model: 'claude-sonnet-5-5',
 * 	reasoning: 'medium',
 * 	system: prompt`You are a senior developer. When the plan doesn't fit, ${requestUserInput}.`,
 * })
 *
 * // Runs on the first of these that a provider with a key offers.
 * export const planner = agent({
 * 	model: ['claude-opus-5-5', 'gpt-5.5'],
 * 	reasoning: 'high',
 * })
 * ```
 */
export function agent(options: AgentOptions): Agent {
	const modelIds = modelIdsOf(options.model)
	defined.set(JSON.stringify(modelIds), modelIds)
	const loopAgent = { model: options.model, reasoning: options.reasoning, system: options.system }
	return Object.freeze<Agent>({
		model: options.model,
		loop(template: TemplateStringsArray, ...values: readonly unknown[]) {
			const site = callSiteText(callSite(1))
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the result type comes from the exits, which only the compiler sees
			return runLoop(loopAgent, { strings: [...template], values }, site) as Promise<never>
		},
		as(name, { in: target, verify: checks = [] } = {}) {
			const site = `${callSiteText(callSite(1))} ${name}`
			return tool(name, {
				description: asToolDescription(target, checks),
				input: z.object({ task: z.string().describe('The whole task, as the agent should do it') }),
				action: async ({ task }) => {
					const result = await runLoop(loopAgent, asToolTask(task, target, checks), site)
					return typeof result === 'string' ? result : 'Done: the work passes the checks.'
				},
			})
		},
	})
}

/** What the other agent reads about an agent as a tool. */
function asToolDescription(target: unknown, checks: readonly Check[]): string {
	const where = target === undefined ? '' : ' in a fixed place'
	const gate = checks.length === 0 ? '' : ` Its work has to pass these checks: ${checks.map((check) => check.name).join(', ')}.`
	return `Ask an agent to do a task${where}. Describe the task completely: the agent sees nothing else.${gate}`
}

/** The loop template an agent as a tool works on: the task, where to work, and how to hand in. */
function asToolTask(task: string, target: unknown, checks: readonly Check[]): { strings: string[]; values: unknown[] } {
	const strings = ['']
	const values: unknown[] = [task]
	if (target !== undefined) {
		strings.push('\n\nWork in ')
		values.push(target)
	}
	if (checks.length > 0) {
		strings.push('\n\nWhen you are done, hand in your work with ')
		values.push(verify(...checks))
	}
	strings.push('')
	return { strings, values }
}
