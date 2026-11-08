import { z } from 'zod'
import type { Check } from '../check/check.mts'
import type { ResultOf } from '../exits/result-of.mts'
import { verify } from '../exits/verify.mts'
import { runLoop } from '../loop/run-loop.mts'
import { callSite, callSiteText } from '../run/call-site.mts'
import { tool, type Tool } from '../tool/tool.mts'
import type { Prompt } from './prompt.mts'

export interface AgentOptions {
	/** A model id, such as `claude-opus-5-5`. The run's providers resolve it, model first. */
	readonly model: string
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
	/** The model id the agent runs on. */
	readonly model: string
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
	loop<Values extends readonly unknown[]>(template: TemplateStringsArray, ...values: Values): Promise<ResultOf<Values>>
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
 * ```
 */
export function agent(options: AgentOptions): Agent {
	const loopAgent = { model: options.model, reasoning: options.reasoning, system: options.system }
	return Object.freeze<Agent>({
		model: options.model,
		loop(template, ...values) {
			const site = callSiteText(callSite(1))
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the result type comes from the exits, which only the compiler sees
			return runLoop(loopAgent, { strings: [...template], values }, site) as Promise<ResultOf<typeof values>>
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
