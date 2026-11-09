import { z } from 'zod'
import { inEventOf } from '../run/run-events.mts'
import { findScope } from '../run/run-scope.mts'
import { untilAborted } from '../run/until-aborted.mts'

/** What a tool's action gets besides its input. */
export interface ToolContext {
	/** Aborted when the call should stop: the run or the loop it runs in was stopped. */
	readonly abortSignal: AbortSignal
}

/** What a tool is made of, for code that runs tools: the loop, and tools of other packages. */
export interface ToolSpec {
	readonly name: string
	readonly description: string | undefined
	readonly input: z.ZodType
	/**
	 * Checks the input against `input` and returns the action, ready to run with it. Throws a
	 * {@link ToolInputError} when the input doesn't fit, so a caller can tell a bad input from a
	 * failing action.
	 */
	readonly prepare: (input: unknown) => (context: ToolContext) => Promise<unknown>
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

/** Any tool, whatever its input and output: what the type checks of templates look for. */
export interface AnyTool {
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
 * 	action: ({ jql }, { abortSignal }) => searchIssues(jql, abortSignal),
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
	const prepare = (input: unknown) => {
		const parsed = definition.input.safeParse(input)
		if (!parsed.success) throw new ToolInputError(`The input of ${name} doesn't fit:\n${z.prettifyError(parsed.error)}`)
		return (context: ToolContext): Promise<Output> => definition.action(parsed.data, context)
	}
	const spec: ToolSpec = { name, description: definition.description, input: definition.input, prepare }
	const call = (input: z.input<Input>, context?: ToolContext): Promise<Output> => callFromCode(spec.name, prepare, input, context)
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
	prepare: (input: unknown) => (context: ToolContext) => Promise<Output>,
	input: unknown,
	context: ToolContext | undefined,
): Promise<Output> {
	const scope = findScope()
	const abortSignal = context?.abortSignal ?? scope?.run.abortSignal
	if (abortSignal === undefined) throw new Error(`Tool ${name} was called outside a workflow run: pass { abortSignal }.`)
	const call = async () => untilAborted(prepare(input)({ abortSignal }), abortSignal)
	if (scope === undefined) return call()
	return inEventOf(scope, 'tool-call', { tool: name, from: 'code', input }, call)
}
