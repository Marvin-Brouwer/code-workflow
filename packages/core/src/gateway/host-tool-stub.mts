import { z } from 'zod'
import { findScope } from '../run/run-scope.mts'
import { assertToolName, toolOf, ToolInputError, type Tool, type ToolContext } from '../tool/tool.mts'
import { GatewayCallError } from './gateway-client.mts'

/**
 * What a host tool and its stub share: the name, what it's for, its input and, for the stub to
 * check, its output. A connector defines it once and hands it to `hostTool` in
 * `@mesh-flow/gateway` and to {@link hostToolStub} here.
 */
export interface HostToolDefinition<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> {
	readonly name: string
	readonly description?: string
	readonly input: Input
	/** What the host tool returns. The stub checks the result against it; without it, the result is `unknown`. */
	readonly output?: Output
	/** A line that says what a call did, to title it in the run view, as `tool`'s `describe`. */
	readonly describe?: (input: z.output<Input>, output: z.output<Output>) => string
}

const defined = new Set<string>()

/** The names of every host tool stub made in this process: what the app calls through the gateway. */
export function definedHostTools(): string[] {
	return [...defined].toSorted()
}

/**
 * The sandbox's side of a tool that runs on the host, with a credential the sandbox never has. It
 * is a tool like any other: interpolated in a loop it's the agent's, called from code it runs. Its
 * input is checked here, so the agent learns early, and again on the host, which is the check
 * that counts.
 *
 * ```ts
 * export const commentDefinition = {
 * 	name: 'githubComment',
 * 	description: 'Comment on a GitHub issue',
 * 	input: z.object({ issue: z.number(), body: z.string() }),
 * 	output: z.object({ posted: z.boolean() }),
 * }
 * export const comment = hostToolStub(commentDefinition)
 *
 * await comment({ issue: 12, body: 'On it.' })
 * ```
 *
 * The app's build lists every stub its modules make, and a run's gateway takes only those.
 */
export function hostToolStub<Input extends z.ZodType, Output extends z.ZodType = z.ZodUnknown>(
	definition: HostToolDefinition<Input, Output>,
): Tool<z.input<Input>, z.output<Output>> {
	const { name } = definition
	assertToolName(name)
	defined.add(name)
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- without an output schema, Output is its default, z.ZodUnknown
	const output = (definition.output ?? z.unknown()) as Output
	return toolOf<z.input<Input>, z.output<Output>>({
		name,
		description: definition.description,
		input: definition.input,
		runsOnHost: true,
		prepare: (input) => {
			const parsed = definition.input.safeParse(input)
			if (!parsed.success) throw new ToolInputError(`The input of ${name} doesn't fit:\n${z.prettifyError(parsed.error)}`)
			return async ({ abortSignal }: ToolContext) => {
				const scope = findScope()
				const gateway = scope?.run.gateway
				if (gateway === undefined) throw new Error(`${name} runs on the host, through the gateway, and this run has none.`)
				const loopEndpoint = scope?.loop?.endpoint
				const endpoint = loopEndpoint?.tools?.has(name) === true ? loopEndpoint : gateway.run
				// The input as given, not as parsed: the host checks it against the same schema.
				const result = await gateway.call(endpoint, { type: 'tool', tool: name, input }, abortSignal)
				const checked = await output.safeParseAsync(result)
				if (!checked.success) throw new GatewayCallError(`${name} returned something else than it says:\n${z.prettifyError(checked.error)}`)
				return { output: checked.data, title: definition.describe?.(parsed.data, checked.data) }
			}
		},
	})
}
