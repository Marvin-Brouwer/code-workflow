import type { GatewayHome, LoginPrompt } from '@mesh-flow/gateway'
import type { Command } from 'commander'
import type { LoadedConnector } from '../connectors/load-connectors.mts'

/** How long `mesh-flow login` waits for the approval: longer than a device code lasts. */
const loginTimeoutMs = 15 * 60 * 1000

/** What `mesh-flow login` needs from the rest of the command line. */
export interface LoginCommandOptions {
	readonly gatewayHome: (abortSignal: AbortSignal) => Promise<GatewayHome>
	/** The connectors the user added, loaded from where the command runs. */
	readonly connectors: (abortSignal: AbortSignal) => Promise<readonly LoadedConnector[]>
	/** Where the prompt and progress go. Default: stderr. */
	readonly log?: (line: string) => void
}

/** The lines that tell the user where to sign in. */
export function formatLoginPrompt(connector: string, prompt: LoginPrompt): string {
	return [
		`Sign in to ${connector}: open ${prompt.url}`,
		`and check that it shows ${prompt.code}. The code works until ${prompt.expiresAt.toLocaleTimeString()}.`,
	].join('\n')
}

/**
 * `mesh-flow login <connector>`: signs in to the service of a connector the user added, such as
 * `aws`, and keeps the session in the gateway's credential store, so runs don't have to ask. Waits
 * until the user approves in the browser; Ctrl+C stops waiting.
 */
export function addLoginCommand(program: Command, options: LoginCommandOptions): void {
	const log =
		options.log ??
		((line: string) => {
			console.error(line)
		})
	program
		.command('login')
		.description("Signs in to a connector's service, such as aws, and keeps the session on this machine.")
		.argument('<connector>', 'the connector, by name, such as aws')
		.action(async (name: string) => {
			const stop = new AbortController()
			const interrupt = () => {
				stop.abort(new Error('Stopped waiting for the sign-in.'))
			}
			process.once('SIGINT', interrupt)
			try {
				const abortSignal = AbortSignal.any([stop.signal, AbortSignal.timeout(loginTimeoutMs)])
				const connectors = await options.connectors(abortSignal)
				const connector = connectors.find((candidate) => candidate.name === name)
				if (connector === undefined) {
					const known = connectors.map((candidate) => candidate.name).join(', ') || 'none'
					throw new Error(`There is no connector ${name}. Added connectors: ${known}. Add one with \`mesh-flow connector add\`.`)
				}
				if (connector.login === undefined) throw new Error(`Connector ${name} has nothing to sign in to.`)
				const { credentials } = await options.gatewayHome(abortSignal)
				await connector.login({
					credentials,
					show: (prompt) => {
						log(formatLoginPrompt(name, prompt))
					},
					abortSignal,
				})
				log(`Signed in to ${name}.`)
			} finally {
				process.off('SIGINT', interrupt)
			}
		})
}
