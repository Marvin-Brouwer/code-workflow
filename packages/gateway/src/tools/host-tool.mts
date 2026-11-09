import { ToolName } from '@mesh-flow/protocol'
import { z } from 'zod'
import type { CredentialReader } from '../credentials/credential-store.mts'

/** What a host tool's action gets besides its input. */
export interface HostToolContext {
	/** Aborted when the call should stop: the runtime cancelled it, or the run stopped. */
	readonly abortSignal: AbortSignal
	/** The gateway's credentials, to read the ones the tool needs. */
	readonly credentials: CredentialReader
	/** The run the call is for, for logs and audit trails such as a session name. */
	readonly runId: string
}

/**
 * What a host tool and its stub in the sandbox share: its name, what it's for and its input. A
 * connector defines it once and hands it to both, so the stub's checks and the host's are the same.
 */
export interface ToolDefinition<Input extends z.ZodType = z.ZodType> {
	readonly name: string
	readonly description?: string
	readonly input: Input
	/** What the tool returns, for the stub in the sandbox to check. The host doesn't. */
	readonly output?: z.ZodType
}

/** A tool that runs on the host with a credential. The sandbox only has its stub. */
export interface HostTool {
	readonly name: string
	/** Checks the input, then runs. Throws a {@link HostToolInputError} when the input doesn't fit. */
	readonly run: (input: unknown, context: HostToolContext) => Promise<unknown>
}

/** A host tool's input didn't fit its schema. Checked on the host, whatever the stub checked. */
export class HostToolInputError extends Error {
	override readonly name = 'HostToolInputError'
}

/**
 * The host half of a credentialed tool. Its code is the only limit on what the credential can do,
 * so it does one thing: there is no raw API for an agent to misuse.
 *
 * ```ts
 * export const commentDefinition = { name: 'githubComment', input: z.object({ issue: z.number(), body: z.string() }) }
 *
 * export const comment = hostTool(commentDefinition, async ({ issue, body }, { credentials, abortSignal }) => {
 * 	const token = await credentials.get('github/token', abortSignal)
 * 	// ... post the comment with the token
 * 	return { posted: true }
 * })
 * ```
 *
 * What it returns goes back to the sandbox as JSON.
 */
export function hostTool<Input extends z.ZodType, Output>(
	definition: ToolDefinition<Input>,
	action: (input: z.output<Input>, context: HostToolContext) => Promise<Output>,
): HostTool {
	const name = ToolName.parse(definition.name)
	return Object.freeze<HostTool>({
		name,
		async run(input, context) {
			const parsed = await definition.input.safeParseAsync(input)
			if (!parsed.success) throw new HostToolInputError(`The input of ${name} doesn't fit:\n${z.prettifyError(parsed.error)}`)
			return action(parsed.data, context)
		},
	})
}
