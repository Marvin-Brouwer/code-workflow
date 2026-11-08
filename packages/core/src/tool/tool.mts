import { z } from 'zod'
import { inEventOf } from '../run/run-events.mts'
import { findScope } from '../run/run-scope.mts'
import { untilAborted } from '../run/until-aborted.mts'

/** What a tool's action gets besides its input. */
export interface ToolContext {
	/** Aborted when the call should stop: the run or the loop it runs in was stopped. */
	readonly signal: AbortSignal
}

/** What a tool is made of, for code that runs tools: the loop, and tools of other packages. */
export interface ToolSpec {
	readonly name: string
	readonly description: string | undefined
	readonly input: z.ZodType
	/** Checks the input against `input`, throwing a {@link ToolInputError} when it doesn't fit, then runs the action. */
	readonly run: (input: unknown, context: ToolContext) => Promise<unknown>
}

/** A tool's input didn't fit its schema. From code that fails the call; from an agent it goes back to the agent. */
export class ToolInputError extends Error {
	override readonly name = 'ToolInputError'
}

const toolSpec: unique symbol = Symbol.for('mesh-flow.tool')

/**
 * A capability an agent can call, and a function code can call. Interpolated in a loop's template
 * it's registered for that loop and renders as its name; called from code it checks its input and
 * runs, with the run's signal.
 */
export interface Tool<Input = never, Output = unknown> {
	/**
	 * Runs the tool. Inside a run the signal is the run's; outside one, pass `context`. The input is
	 * checked against the tool's schema first, and a mismatch throws.
	 */
	(input: Input, context?: ToolContext): Promise<Output>
	readonly name: string
	readonly description: string | undefined
	readonly [toolSpec]: ToolSpec
}

/** Names that every model provider accepts for a tool. */
const toolNamePattern = /^[A-Za-z][\w-]{0,63}$/

/**
 * Defines a tool. The action gets input that matches `input`, and the tool's signal.
 *
 * ```ts
 * export const search = tool('jiraSearch', {
 * 	description: 'Search Jira issues with JQL',
 * 	input: z.object({ jql: z.string() }),
 * 	action: ({ jql }, { signal }) => searchIssues(jql, signal),
 * })
 * ```
 *
 * A tool validates its own input, retries its own transient failures and caps its own output. A
 * failure the agent should see (nothing found, a bad argument) is a result, not a throw: inside a
 * loop, a throw fails the loop.
 */
export function tool<Input extends z.ZodType, Output>(
	name: string,
	definition: {
		readonly description?: string
		readonly input: Input
		readonly action: (input: z.output<Input>, context: ToolContext) => Promise<Output>
	},
): Tool<z.input<Input>, Output> {
	if (!toolNamePattern.test(name))
		throw new Error(`Tool name ${name} doesn't work for every model provider: use letters, digits, _ and -, up to 64.`)
	const run = async (input: unknown, context: ToolContext): Promise<Output> => {
		const parsed = definition.input.safeParse(input)
		if (!parsed.success) throw new ToolInputError(`The input of ${name} doesn't fit:\n${z.prettifyError(parsed.error)}`)
		return definition.action(parsed.data, context)
	}
	const spec: ToolSpec = { name, description: definition.description, input: definition.input, run }
	const call = (input: z.input<Input>, context?: ToolContext): Promise<Output> => callFromCode(spec.name, run, input, context)
	Object.defineProperty(call, 'name', { value: name })
	return Object.assign(call, { description: definition.description, [toolSpec]: spec })
}

/** Whether a value is a tool made by {@link tool}. */
export function isTool(value: unknown): value is Tool {
	return typeof value === 'function' && toolSpec in value
}

/** The spec behind a tool. */
export function specOf(value: Tool): ToolSpec {
	return value[toolSpec]
}

async function callFromCode<Output>(
	name: string,
	run: (input: unknown, context: ToolContext) => Promise<Output>,
	input: unknown,
	context: ToolContext | undefined,
): Promise<Output> {
	const scope = findScope()
	const signal = context?.signal ?? scope?.run.signal
	if (signal === undefined) throw new Error(`Tool ${name} was called outside a workflow run: pass { signal }.`)
	if (scope === undefined) return untilAborted(run(input, { signal }), signal)
	return inEventOf(scope, 'tool-call', { tool: name, from: 'code', input }, () => untilAborted(run(input, { signal }), signal))
}
