import { CallAnswer, EndpointGrant, GatewayCall, type Answer, type RunGrant, type RuntimeMessage } from '@mesh-flow/protocol'
import { z } from 'zod'
import { waitingOnHuman } from '../loop/loop-clock.mts'
import { untilAborted } from '../run/until-aborted.mts'
import { TokenPool } from './token-pool.mts'

/** How the gateway client reaches the engine: the runtime's mailbox, or a test's own. */
export interface GatewayChannel {
	send(message: RuntimeMessage): void
	/** Waits for the answer to a call, then removes it, since it holds a token. */
	take(requestId: string, abortSignal: AbortSignal): Promise<Answer>
	/** Where a body a call's answer names was staged, such as a package's. Whoever reads it removes it. */
	staged(name: string): string
}

/** An endpoint on the gateway: its id and the host tools it takes. Its tokens stay in the client. */
export interface Endpoint {
	readonly id: string
	/** The host tools it takes. `undefined` for the run's own endpoint, which takes every tool the app lists. */
	readonly tools: ReadonlySet<string> | undefined
}

/** What a `GatewayCallError` says beyond its message. */
export interface GatewayCallErrorOptions {
	/** The failure may pass on another try. Default: false. */
	readonly transient?: boolean
}

/**
 * A call to the gateway failed on the host: refused, or the host tool or the provider failed.
 * `transient` says the failure may pass on another try (the network or the service was down, or the
 * engine stopped mid-call), so code that only reads may look again later.
 */
export class GatewayCallError extends Error {
	override readonly name = 'GatewayCallError'
	readonly transient: boolean

	constructor(message: string, options: GatewayCallErrorOptions = {}) {
		super(message)
		this.transient = options.transient ?? false
	}
}

/**
 * The runtime's side of the gateway: calls on the run's endpoint and on loops' endpoints, each on a
 * token the last answer handed out. Tokens live only here, in the runtime's memory.
 */
export interface GatewayClient {
	/** The run's own endpoint, for calls from workflow code and for model calls. */
	readonly run: Endpoint
	/** The run's package endpoint, for package fetches only, when the app restores packages. */
	readonly packages: Endpoint | undefined
	/**
	 * Calls the gateway on `endpoint` and resolves to the result. Throws a {@link GatewayCallError}
	 * when the host says no. When the host says the user has to sign in to a connector first, it
	 * asks the engine for a `login`, waits for it as for a human, and calls again.
	 */
	call(endpoint: Endpoint, call: GatewayCall, abortSignal: AbortSignal): Promise<unknown>
	/** Opens an endpoint for one loop that takes only `tools`. */
	openLoop(tools: readonly string[], abortSignal: AbortSignal): Promise<Endpoint>
	/** Closes a loop's endpoint once the loop has settled. */
	closeLoop(endpoint: Endpoint, abortSignal: AbortSignal): Promise<void>
	/** Where a body a call's answer names was staged, such as a package's. Whoever reads it removes it. */
	staged(name: string): string
}

/**
 * How many times a call goes on after its tool asked for a sign-in, before it fails: once for the
 * session it needed, and once more in case the sign-in it went on after was another call's.
 */
const maxSignInsPerCall = 2

/** A sign-in the runtime asked the engine for, and the calls that wait for it. */
interface SignIn {
	/** Settles when the engine answered that the user signed in. */
	readonly answered: Promise<void>
	/** How many calls wait for it now. At 0 it is stopped. */
	waiters: number
	/** Stops waiting for the answer, and tells the engine nothing waits for it any more. */
	readonly stop: () => void
}

/** What a call answered with, once it was answered. */
type CallOutcome = CallAnswer['outcome']

/**
 * A client on `channel` for the run's endpoint in `grant`. `runAbortSignal` is the run's signal: a
 * call the caller stopped waiting for is cancelled on the host, and its answer, with the next
 * token, is still picked up until the run ends.
 */
export function gatewayClient(channel: GatewayChannel, grant: RunGrant, idPrefix: string, runAbortSignal: AbortSignal): GatewayClient {
	let callCount = 0
	let loginCount = 0
	/** The sign-ins asked for and not answered yet, by connector, so calls that need the same one share it. */
	const signIns = new Map<string, SignIn>()
	/** How many sign-ins were answered, so a call that was sent before one was answered tries again without asking. */
	let answeredSignIns = 0
	const pools = new Map<string, TokenPool>([[grant.endpoint, new TokenPool(grant.tokens)]])
	if (grant.packages !== undefined) pools.set(grant.packages.endpoint, new TokenPool(grant.packages.tokens))
	const run: Endpoint = Object.freeze({ id: grant.endpoint, tools: undefined })
	const packages: Endpoint | undefined = grant.packages && Object.freeze({ id: grant.packages.endpoint, tools: new Set<string>() })
	const poolOf = (endpoint: Endpoint) => {
		const pool = pools.get(endpoint.id)
		if (pool === undefined) throw new GatewayCallError(`Endpoint ${endpoint.id} is closed.`)
		return pool
	}

	const callOnce = async (endpoint: Endpoint, checked: GatewayCall, abortSignal: AbortSignal): Promise<CallOutcome> => {
		const pool = poolOf(endpoint)
		const token = await pool.take(abortSignal)
		const id = `call-${idPrefix}-${String(++callCount)}`
		channel.send({ type: 'call', id, endpoint: endpoint.id, token, call: checked })
		// Whether the answer was taken already, so a stop that comes after it doesn't wait for it again.
		const progress = { taken: false }
		const answered = channel.take(id, AbortSignal.any([abortSignal, runAbortSignal])).then((answer) => {
			progress.taken = true
			const parsed = CallAnswer.parse(answer.value)
			if (parsed.next !== undefined) pool.give(parsed.next)
			return parsed
		})
		try {
			return (await answered).outcome
		} catch (error) {
			if (progress.taken || !abortSignal.aborted || runAbortSignal.aborted) throw error
			channel.send({ type: 'cancel', id })
			// The answer still comes, with the next token: the rest of the run needs it.
			const recovered = channel.take(id, runAbortSignal).then((answer) => {
				const next = CallAnswer.safeParse(answer.value)
				if (next.success && next.data.next !== undefined) pool.give(next.data.next)
			})
			recovered.catch(() => undefined)
			throw error
		}
	}

	/**
	 * Asks the engine for a sign-in to `connector` and waits for it, as for a human: it doesn't count
	 * toward a loop's `limit`. Calls that need the same sign-in share it, and once none of them waits
	 * any more, the request is cancelled, so the engine stops asking the user for it.
	 */
	const waitForSignIn = async (connector: string, abortSignal: AbortSignal): Promise<void> => {
		const signIn = signIns.get(connector) ?? askForSignIn(connector)
		signIn.waiters++
		try {
			await waitingOnHuman(() => untilAborted(signIn.answered, abortSignal))
		} finally {
			signIn.waiters--
			if (signIn.waiters === 0 && signIns.get(connector) === signIn) {
				signIns.delete(connector)
				signIn.stop()
			}
		}
	}

	const askForSignIn = (connector: string): SignIn => {
		const id = `login-${idPrefix}-${String(++loginCount)}`
		const stopped = new AbortController()
		channel.send({ type: 'request', request: { kind: 'login', id, connector } })
		const answered = channel.take(id, AbortSignal.any([runAbortSignal, stopped.signal])).then(() => {
			answeredSignIns++
		})
		answered.catch(() => undefined)
		const signIn: SignIn = {
			answered,
			waiters: 0,
			stop: () => {
				stopped.abort(new Error(`Nothing waits for the sign-in to ${connector} any more.`))
				if (!runAbortSignal.aborted) channel.send({ type: 'cancel', id })
			},
		}
		const forget = () => {
			if (signIns.get(connector) === signIn) signIns.delete(connector)
		}
		void answered.then(forget, forget)
		signIns.set(connector, signIn)
		return signIn
	}

	const call = async (endpoint: Endpoint, gatewayCall: GatewayCall, abortSignal: AbortSignal): Promise<unknown> => {
		// The engine reads the outbox strictly: a call it can't read would fail the whole run.
		const checked = GatewayCall.safeParse(gatewayCall)
		if (!checked.success) throw new GatewayCallError(`The ${gatewayCall.type} call isn't valid:\n${z.prettifyError(checked.error)}`)
		let signInRounds = 0
		for (;;) {
			const answeredBefore = answeredSignIns
			const outcome = await callOnce(endpoint, checked.data, abortSignal)
			if (outcome.ok) return outcome.result
			if (outcome.signInTo === undefined) throw new GatewayCallError(outcome.error, { transient: outcome.transient === true })
			// A tool that still asks after the user signed in won't stop asking: the run gets why.
			if (signInRounds >= maxSignInsPerCall) throw new GatewayCallError(outcome.error)
			signInRounds++
			// A sign-in answered while the call was on its way may be the one it needs.
			if (answeredSignIns === answeredBefore) await waitForSignIn(outcome.signInTo, abortSignal)
		}
	}

	return Object.freeze<GatewayClient>({
		run,
		packages,
		call,
		async openLoop(tools, abortSignal) {
			const opened = EndpointGrant.parse(await call(run, { type: 'open', tools: [...tools] }, abortSignal))
			pools.set(opened.endpoint, new TokenPool(opened.tokens))
			return Object.freeze({ id: opened.endpoint, tools: new Set(tools) })
		},
		async closeLoop(endpoint, abortSignal) {
			pools.delete(endpoint.id)
			await call(run, { type: 'close', endpoint: endpoint.id }, abortSignal)
		},
		staged: (name) => channel.staged(name),
	})
}
