import { setTimeout as delay } from 'node:timers/promises'
import { abortable } from '@mesh-flow/sandbox'
import type { LoadedConnector } from '../connectors/load-connectors.mts'
import { messageOf } from '../errors.mts'
import { EngineError } from './engine-error.mts'
import { signInFailedLine, signInPromptMessage } from './sign-in-lines.mts'
import { shownSignInPrompt, type SignInState } from './sign-in-state.mts'

/**
 * The sign-ins runs and `mesh-flow login` wait for. There is one at a time per connector, whoever
 * waits for it: every run that needs the AWS session waits on the same device authorization.
 */
export interface SignIns {
	/** Whether `connector` is one that signs in. */
	readonly has: (connector: string) => boolean
	/**
	 * Waits until the user signed in to `connector`: starts its sign-in, or joins the one under way.
	 * A try that fails, such as a code that ran out, is followed by another. Once nobody waits for
	 * it any more, the sign-in goes on for a while, until the code it showed runs out: a package
	 * manager that timed out tries again, and the user is still approving that code.
	 */
	readonly waitFor: (connector: string, abortSignal: AbortSignal) => Promise<void>
	/** The sign-ins under way. */
	readonly list: () => SignInState[]
	/** Stops every sign-in, also those nobody waits for, such as when the engine shuts down. */
	readonly close: () => void
}

/** What {@link openSignIns} works on. */
export interface SignInsOptions {
	/** The connectors the engine loaded. Those with a `signIn` can be signed in to. */
	readonly connectors: readonly Pick<LoadedConnector, 'name' | 'signIn'>[]
	/** Where to say what happened, such as a failed try. Default: nowhere. */
	readonly log?: (message: string) => void
	/**
	 * How long to wait after a failed try before the next one. Each wait after another failed try
	 * is twice the one before, up to 5 minutes, or `retryMs` itself if
	 * that is longer. A try that got as far as a code starts over from `retryMs`, so a code that
	 * ran out is followed by a new one soon. Default: 10 seconds.
	 */
	readonly retryMs?: number
	/**
	 * How long a sign-in nobody waits for goes on, at least: longer while the code it showed is
	 * still good. Default: a minute.
	 */
	readonly idleMs?: number
}

/** The error for a connector that doesn't sign in, or that the engine didn't load. */
export function noSignInError(connector: string): EngineError {
	return new EngineError('not-found', `There is no connector ${connector} that signs in.`)
}

/** How long to wait after a failed sign-in before the next try, unless told otherwise. */
const defaultRetryMs = 10_000

/** The longest wait between two tries, so a sign-in nobody approves doesn't ask the service every few seconds for hours. */
const maxRetryMs = 5 * 60_000

/** How much longer each wait is than the one before, while tries keep failing before they get a code. */
const retryBackoffFactor = 2

/** How long a sign-in nobody waits for goes on at least, unless told otherwise. */
const defaultIdleMs = 60_000

/** What a sign-in under way shows: where to sign in, or why the last try failed. */
interface Shown {
	prompt?: SignInState['prompt']
	error?: string
}

/** One connector's sign-in, while anyone waits for it, or for a while after. */
interface SignIn {
	readonly controller: AbortController
	/** Settles once the user signed in. */
	readonly settled: Promise<void>
	readonly shown: Shown
	/** How many wait for it now. At 0 it is stopped a while later. */
	waiters: number
	/** Stops the sign-in once nobody has waited for it for a while. */
	idle?: NodeJS.Timeout
}

/** The sign-ins of an engine's connectors. Nothing starts until something waits for one. */
export function openSignIns(options: SignInsOptions): SignIns {
	const log = options.log ?? (() => undefined)
	const retryMs = options.retryMs ?? defaultRetryMs
	const idleMs = options.idleMs ?? defaultIdleMs
	const signInTo = new Map(options.connectors.flatMap(({ name, signIn }) => (signIn === undefined ? [] : [[name, signIn] as const])))
	const underWay = new Map<string, SignIn>()

	const stop = (connector: string, signIn: SignIn, reason: string) => {
		clearTimeout(signIn.idle)
		if (underWay.get(connector) === signIn) underWay.delete(connector)
		signIn.controller.abort(new Error(reason))
	}

	const start = (connector: string, signInOnce: NonNullable<LoadedConnector['signIn']>): SignIn => {
		const controller = new AbortController()
		const abortSignal = controller.signal
		const shown: Shown = {}
		const tryUntilSignedIn = async () => {
			let waitMs = retryMs
			for (;;) {
				try {
					await signInOnce({
						show: (prompt) => {
							waitMs = retryMs
							delete shown.error
							shown.prompt = shownSignInPrompt(prompt)
							log(signInPromptMessage(connector, shown.prompt))
						},
						abortSignal,
					})
					log(`Signed in to ${connector}.`)
					return
				} catch (error) {
					abortSignal.throwIfAborted()
					const message = messageOf(error)
					// The same failure again says nothing new.
					if (message !== shown.error) log(signInFailedLine(connector, message))
					shown.error = message
					delete shown.prompt
					await delay(waitMs, undefined, { signal: abortSignal })
					waitMs = Math.min(waitMs * retryBackoffFactor, Math.max(retryMs, maxRetryMs))
				}
			}
		}
		const signIn: SignIn = { controller, settled: tryUntilSignedIn(), shown, waiters: 0 }
		signIn.settled.catch(() => undefined)
		const forget = () => {
			clearTimeout(signIn.idle)
			if (underWay.get(connector) === signIn) underWay.delete(connector)
		}
		void signIn.settled.then(forget, forget)
		underWay.set(connector, signIn)
		return signIn
	}

	return Object.freeze<SignIns>({
		has: (connector) => signInTo.has(connector),
		waitFor: async (connector, abortSignal) => {
			const signInOnce = signInTo.get(connector)
			if (signInOnce === undefined) throw noSignInError(connector)
			abortSignal.throwIfAborted()
			const signIn = underWay.get(connector) ?? start(connector, signInOnce)
			clearTimeout(signIn.idle)
			signIn.waiters++
			try {
				await abortable(signIn.settled, abortSignal)
			} finally {
				signIn.waiters--
				if (signIn.waiters === 0 && underWay.get(connector) === signIn) {
					const codeLeftMs = signIn.shown.prompt === undefined ? 0 : Date.parse(signIn.shown.prompt.expiresAt) - Date.now()
					signIn.idle = setTimeout(
						() => {
							stop(connector, signIn, `Nobody waits for the sign-in to ${connector} any more.`)
						},
						Math.max(idleMs, codeLeftMs),
					)
					signIn.idle.unref()
				}
			}
		},
		list: () => [...underWay].map(([connector, { shown }]) => ({ connector, ...shown })),
		close: () => {
			for (const [connector, signIn] of underWay) stop(connector, signIn, 'The engine is shutting down.')
		},
	})
}
