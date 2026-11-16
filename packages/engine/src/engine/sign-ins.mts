import { setTimeout as delay } from 'node:timers/promises'
import { abortable } from '@mesh-flow/sandbox'
import { z } from 'zod'
import type { LoadedConnector } from '../connectors/load-connectors.mts'
import { messageOf } from '../errors.mts'
import { EngineError } from './engine-error.mts'

/** A sign-in under way, as `mesh-flow show` and `mesh-flow login` show it. */
export const SignInState = z.object({
	connector: z.string(),
	/** Where to sign in, once the service handed out a code. */
	prompt: z.object({ url: z.string(), code: z.string(), expiresAt: z.iso.datetime() }).optional(),
	/** Why the last try failed, when it did. Another one follows. */
	error: z.string().optional(),
})
export type SignInState = z.infer<typeof SignInState>

/**
 * The sign-ins runs and `mesh-flow login` wait for. There is one at a time per connector, whoever
 * waits for it: every run that needs the AWS session waits on the same device authorization.
 */
export interface SignIns {
	/** Whether `connector` is one that signs in. */
	readonly has: (connector: string) => boolean
	/**
	 * Waits until the user signed in to `connector`: starts its sign-in, or joins the one under way.
	 * A try that fails, such as a code that ran out, is followed by another. The sign-in stops once
	 * nobody waits for it any more.
	 */
	readonly waitFor: (connector: string, abortSignal: AbortSignal) => Promise<void>
	/** The sign-ins under way. */
	readonly list: () => SignInState[]
}

/** What {@link openSignIns} works on. */
export interface SignInsOptions {
	/** The connectors the engine loaded. Those with a `login` can be signed in to. */
	readonly connectors: readonly Pick<LoadedConnector, 'name' | 'login'>[]
	/** Where to say what happened, such as a failed try. Default: nowhere. */
	readonly log?: (message: string) => void
	/** How long to wait after a failed try before the next one. Default: 10 seconds. */
	readonly retryMs?: number
}

/** How long to wait after a failed sign-in before the next try, unless told otherwise. */
const defaultRetryMs = 10_000

/** What a sign-in under way shows: where to sign in, or why the last try failed. */
interface Shown {
	prompt?: SignInState['prompt']
	error?: string
}

/** One connector's sign-in, while anyone waits for it. */
interface SignIn {
	readonly controller: AbortController
	readonly done: Promise<void>
	readonly shown: Shown
	waiters: number
}

/** The sign-ins of an engine's connectors. Nothing starts until something waits for one. */
export function openSignIns(options: SignInsOptions): SignIns {
	const log = options.log ?? (() => undefined)
	const retryMs = options.retryMs ?? defaultRetryMs
	const logins = new Map(options.connectors.flatMap(({ name, login }) => (login === undefined ? [] : [[name, login] as const])))
	const underWay = new Map<string, SignIn>()

	const start = (connector: string, login: NonNullable<LoadedConnector['login']>): SignIn => {
		const controller = new AbortController()
		const abortSignal = controller.signal
		const shown: Shown = {}
		const tryUntilSignedIn = async () => {
			for (;;) {
				try {
					await login({
						show: (prompt) => {
							delete shown.error
							shown.prompt = { url: prompt.url, code: prompt.code, expiresAt: prompt.expiresAt.toISOString() }
							log(`Sign in to ${connector}: open ${prompt.url} and check that it shows ${prompt.code}.`)
						},
						abortSignal,
					})
					log(`Signed in to ${connector}.`)
					return
				} catch (error) {
					abortSignal.throwIfAborted()
					shown.error = messageOf(error)
					delete shown.prompt
					log(`Signing in to ${connector} failed, trying again: ${shown.error}`)
					await delay(retryMs, undefined, { signal: abortSignal })
				}
			}
		}
		const signIn: SignIn = { controller, done: tryUntilSignedIn(), shown, waiters: 0 }
		signIn.done.catch(() => undefined)
		const forget = () => {
			if (underWay.get(connector) === signIn) underWay.delete(connector)
		}
		void signIn.done.then(forget, forget)
		underWay.set(connector, signIn)
		return signIn
	}

	return Object.freeze<SignIns>({
		has: (connector) => logins.has(connector),
		async waitFor(connector, abortSignal) {
			const login = logins.get(connector)
			if (login === undefined) throw new EngineError('not-found', `There is no connector ${connector} that signs in.`)
			abortSignal.throwIfAborted()
			const signIn = underWay.get(connector) ?? start(connector, login)
			signIn.waiters++
			try {
				await abortable(signIn.done, abortSignal)
			} finally {
				signIn.waiters--
				if (signIn.waiters === 0 && underWay.get(connector) === signIn) {
					underWay.delete(connector)
					signIn.controller.abort(new Error(`Nobody waits for the sign-in to ${connector} any more.`))
				}
			}
		},
		list: () =>
			[...underWay].map(
				([
					connector,
					{
						shown: { prompt, error },
					},
				]) => ({
					connector,
					...(prompt === undefined ? {} : { prompt }),
					...(error === undefined ? {} : { error }),
				}),
			),
	})
}
