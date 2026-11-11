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
 * A host tool failed on something that may pass on another try, such as a dropped connection or
 * a service that answered 5xx: the stub's caller gets a `GatewayCallError` marked `transient`, so a
 * watch can look again later instead of failing. A tool throws it only after its own retries.
 */
export class HostToolTransientError extends Error {
	override readonly name = 'HostToolTransientError'
	readonly transient = true
}

/**
 * Whether `error` says it may pass on another try. Checked by its `transient` field, not by class,
 * since a connector package may bring its own copy of this package.
 */
export function isTransient(error: unknown): boolean {
	return error instanceof Error && 'transient' in error && error.transient === true
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

/** What a connector's host half gets to make its tools. */
export interface ConnectorHostOptions {
	/** A directory of the connector's own in the gateway's home, for what it keeps between calls, such as clones. */
	readonly directory: string
}

/**
 * The host half of a connector package, as its `host` entry point exports it: a name, and the
 * host tools it brings. The engine loads the connectors the user added and gives every run the
 * tools of them its app lists.
 *
 * ```ts
 * export const connector = connectorHost('github', ({ directory }) => githubHostTools({ directory }))
 * ```
 */
export interface ConnectorHost {
	/** Names the connector, as a directory name: lowercase letters, digits and dashes. */
	readonly name: string
	readonly tools: (options: ConnectorHostOptions) => readonly HostTool[]
}

/** Connector names: they go into directory names. */
export const ConnectorName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and dashes.')

/** Defines the host half of a connector, checked. */
export function connectorHost(name: string, tools: ConnectorHost['tools']): ConnectorHost {
	return Object.freeze<ConnectorHost>({ name: ConnectorName.parse(name), tools })
}
