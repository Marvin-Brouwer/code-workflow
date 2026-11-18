import { setTimeout as delay } from 'node:timers/promises'
import type { CredentialStore } from '@mesh-flow/gateway'
import type { Command } from 'commander'
import type { LoadedConnector } from '../connectors/load-connectors.mts'
import { ControlError, type ControlClient } from '../control/control-client.mts'
import { signInFailedLine } from '../engine/sign-in-state.mts'
import { formatLoginPrompt } from './format-login-prompt.mts'

/** How long `mesh-flow login` waits for the approval: longer than a device code lasts. */
const loginTimeoutMs = 15 * 60 * 1000

/** How often `mesh-flow login` looks for the code of the engine's sign-in. */
const promptPollMs = 500

/** What `mesh-flow login` uses of the engine: its sign-ins come first, so the runs that wait for one go on. */
export type EngineSignIns = Pick<ControlClient, 'signIns' | 'signIn'>

/** What `mesh-flow login` needs from the rest of the command line. */
export interface LoginCommandOptions {
	/** The gateway's credentials, for signing in on its own when no engine serves. */
	readonly credentials: (abortSignal: AbortSignal) => Promise<CredentialStore>
	/** The connectors the user added, loaded from where the command runs, with those credentials. */
	readonly connectors: (credentials: CredentialStore, abortSignal: AbortSignal) => Promise<readonly LoadedConnector[]>
	/**
	 * A client for the engine serving this home. When none serves, its calls throw a `ControlError`
	 * without a status, and the command signs in on its own.
	 */
	readonly engine: () => EngineSignIns
	/** Where the prompt and progress go. Default: stderr. */
	readonly log?: (line: string) => void
}

/**
 * `mesh-flow login <connector>`: signs in to the service of a connector the user added, such as
 * `aws`, and keeps the session in the gateway's credential store, so runs don't have to ask. When an
 * engine serves, it joins the engine's sign-in, so runs waiting for one share its code and go on.
 * Waits until the user approves in the browser; Ctrl+C stops waiting.
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
				const joined = await signInThroughEngine(options.engine(), name, log, abortSignal)
				if (!joined) await signInHere(options, name, log, abortSignal)
				log(`Signed in to ${name}.`)
			} finally {
				process.off('SIGINT', interrupt)
			}
		})
}

/** What the race in {@link signInThroughEngine} settles with when the engine's sign-in hasn't. */
const notYet = Symbol('not yet')

/** The status the engine answers with when it has no connector of that name that signs in. */
const notFoundStatus = 404

/**
 * Joins the sign-in of the engine that serves, showing its code, and why a try failed. Resolves
 * `false` when no engine serves, or the one that serves didn't load the connector, so the command
 * signs in on its own: the session goes to the same store, which the engine reads on every call.
 */
async function signInThroughEngine(
	engine: EngineSignIns,
	name: string,
	log: (line: string) => void,
	abortSignal: AbortSignal,
): Promise<boolean> {
	try {
		await engine.signIns(abortSignal)
	} catch (error) {
		if (error instanceof ControlError && error.status === undefined) return false
		throw error
	}
	const signedIn = engine.signIn(name, abortSignal).then(
		() => true,
		(error: unknown) => {
			if (!(error instanceof ControlError) || error.status !== notFoundStatus) throw error
			log(`The engine that serves doesn't sign in to ${name}; signing in here. Restart it to load the connector.`)
			return false
		},
	)
	// Raced below; a failure to look for the code first mustn't leave it unhandled.
	signedIn.catch(() => undefined)
	let shownCode: string | undefined
	let shownError: string | undefined
	for (;;) {
		const looked = delay<typeof notYet>(promptPollMs, notYet, { signal: abortSignal })
		looked.catch(() => undefined)
		const settled = await Promise.race([signedIn, looked])
		if (settled !== notYet) return settled
		const signIn = (await engine.signIns(abortSignal)).find((candidate) => candidate.connector === name)
		const prompt = signIn?.prompt
		if (prompt !== undefined && prompt.code !== shownCode) {
			shownCode = prompt.code
			log(formatLoginPrompt(name, { url: prompt.url, code: prompt.code, expiresAt: new Date(prompt.expiresAt) }))
		}
		if (signIn?.error !== undefined && signIn.error !== shownError) log(signInFailedLine(name, signIn.error))
		shownError = signIn?.error
	}
}

/** Signs in with the connector's own sign-in, in this process, when no engine serves. */
async function signInHere(
	options: LoginCommandOptions,
	name: string,
	log: (line: string) => void,
	abortSignal: AbortSignal,
): Promise<void> {
	const credentials = await options.credentials(abortSignal)
	const connectors = await options.connectors(credentials, abortSignal)
	const connector = connectors.find((candidate) => candidate.name === name)
	if (connector === undefined) {
		const known = connectors.map((candidate) => candidate.name).join(', ') || 'none'
		throw new Error(`There is no connector ${name}. Added connectors: ${known}. Add one with \`mesh-flow connector add\`.`)
	}
	if (connector.login === undefined) throw new Error(`Connector ${name} has nothing to sign in to.`)
	await connector.login({
		show: (prompt) => {
			log(formatLoginPrompt(name, prompt))
		},
		abortSignal,
	})
}
