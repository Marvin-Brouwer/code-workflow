import { z } from 'zod'
import { callOutcome } from '../run/call-outcome.mts'
import { inEventOf } from '../run/run-events.mts'
import { findScope } from '../run/run-scope.mts'
import { untilAborted } from '../run/until-aborted.mts'
import { titleOf } from './title-of.mts'

/** What a tool's action gets besides its input. */
export interface ToolContext {
	/** Aborted when the call should stop: the run or the loop it runs in was stopped. */
	readonly abortSignal: AbortSignal
}

/** What a tool is made of, for code that runs tools: the loop, and tools of other packages. */
export interface ToolSpecification {
	readonly name: string
	readonly description: string | undefined
	readonly input: z.ZodType
	/**
	 * Checks the input against `input` and returns the action, ready to run with it. Throws a
	 * {@link ToolInputError} when the input doesn't fit, so a caller can tell a bad input from a
	 * failing action.
	 */
	readonly prepare: (input: unknown) => (context: ToolContext) => Promise<ToolOutcome<unknown>>
	/** Set for a stub of a host tool: it runs on the host, through the gateway, and a loop that has it opens an endpoint for it. */
	readonly runsOnHost?: true
}

/** What a tool call returned, and the line that titles it in the run view, from the tool's `describe`. */
export interface ToolOutcome<Output> {
	readonly output: Output
	readonly title: string | undefined
}

/** A tool's input didn't fit its schema. From code that fails the call; from an agent it goes back to the agent. */
export class ToolInputError extends Error {
	override readonly name = 'ToolInputError'
}

const toolSpecification: unique symbol = Symbol.for('mesh-flow.tool')

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
	readonly [toolSpecification]: ToolSpecification
}

/** Any tool, whatever its input and output: what the type checks of templates look for. */
export interface AnyTool {
	readonly [toolSpecification]: ToolSpecification
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
		/**
		 * A line that says what a call did, such as `Collected issue #63`, to title it in the run
		 * view. Without it, or when it throws, the call is titled by the tool's name. It runs after
		 * every call, so keep it to reading its arguments.
		 */
		readonly describe?: (input: z.output<Input>, output: Output) => string
	},
): Tool<z.input<Input>, Output> {
	assertToolName(name)
	const { describe } = definition
	const prepare = (input: unknown) => {
		const parsed = definition.input.safeParse(input)
		if (!parsed.success) throw new ToolInputError(`The input of ${name} doesn't fit:\n${z.prettifyError(parsed.error)}`)
		return async (context: ToolContext): Promise<ToolOutcome<Output>> => {
			const output = await definition.action(parsed.data, context)
			return { output, title: titleOf(describe, parsed.data, output) }
		}
	}
	return toolOf<z.input<Input>, Output>({ name, description: definition.description, input: definition.input, prepare })
}

/** The tool for a specification: a function that checks its input and runs, and the specification behind it. */
export function toolOf<Input, Output>(specification: ToolSpecification): Tool<Input, Output> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the specification's action returns what the tool's definition says
	const prepare = specification.prepare as (input: unknown) => (context: ToolContext) => Promise<ToolOutcome<Output>>
	const call = (input: Input, context?: ToolContext): Promise<Output> => callFromCode(specification.name, prepare, input, context)
	Object.defineProperty(call, 'name', { value: specification.name })
	return Object.assign(call, { description: specification.description, [toolSpecification]: specification })
}

/** Throws when `name` isn't a tool name every model provider accepts. */
export function assertToolName(name: string): void {
	if (!toolNamePattern.test(name))
		throw new Error(`Tool name ${name} doesn't work for every model provider: use letters, digits, _ and -, up to 64.`)
}

/** Whether a value is a tool made by {@link tool}. */
export function isTool(value: unknown): value is Tool {
	return typeof value === 'function' && toolSpecification in value
}

/** The specification behind a tool. */
export function specificationOf(value: Tool): ToolSpecification {
	return value[toolSpecification]
}

async function callFromCode<Output>(
	name: string,
	prepare: (input: unknown) => (context: ToolContext) => Promise<ToolOutcome<Output>>,
	input: unknown,
	context: ToolContext | undefined,
): Promise<Output> {
	const scope = findScope()
	const abortSignal = context?.abortSignal ?? scope?.run.abortSignal
	if (abortSignal === undefined) throw new Error(`Tool ${name} was called outside a workflow run: pass { abortSignal }.`)
	const call = async () => untilAborted(prepare(input)({ abortSignal }), abortSignal)
	if (scope === undefined) return (await call()).output
	const { output } = await inEventOf(scope, 'tool-call', { tool: name, from: 'code', input }, call, callOutcome)
	return output
}
