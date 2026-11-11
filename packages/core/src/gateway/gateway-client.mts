import { CallAnswer, EndpointGrant, type Answer, type GatewayCall, type RuntimeMessage } from '@mesh-flow/protocol'
import { TokenPool } from './token-pool.mts'

/** How the gateway client reaches the engine: the runtime's mailbox, or a test's own. */
export interface GatewayChannel {
	send(message: RuntimeMessage): void
	/** Waits for the answer to a call, then removes it, since it holds a token. */
	take(requestId: string, abortSignal: AbortSignal): Promise<Answer>
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
	/** Calls the gateway on `endpoint` and resolves to the result. Throws a {@link GatewayCallError} when the host says no. */
	call(endpoint: Endpoint, call: GatewayCall, abortSignal: AbortSignal): Promise<unknown>
	/** Opens an endpoint for one loop that takes only `tools`. */
	openLoop(tools: readonly string[], abortSignal: AbortSignal): Promise<Endpoint>
	/** Closes a loop's endpoint once the loop has settled. */
	closeLoop(endpoint: Endpoint, abortSignal: AbortSignal): Promise<void>
}

/**
 * A client on `channel` for the run's endpoint in `grant`. `runAbortSignal` is the run's signal: a
 * call the caller stopped waiting for is cancelled on the host, and its answer, with the next
 * token, is still picked up until the run ends.
 */
export function gatewayClient(channel: GatewayChannel, grant: EndpointGrant, idPrefix: string, runAbortSignal: AbortSignal): GatewayClient {
	let callCount = 0
	const pools = new Map<string, TokenPool>([[grant.endpoint, new TokenPool(grant.tokens)]])
	const run: Endpoint = Object.freeze({ id: grant.endpoint, tools: undefined })
	const poolOf = (endpoint: Endpoint) => {
		const pool = pools.get(endpoint.id)
		if (pool === undefined) throw new GatewayCallError(`Endpoint ${endpoint.id} is closed.`)
		return pool
	}

	const call = async (endpoint: Endpoint, gatewayCall: GatewayCall, abortSignal: AbortSignal): Promise<unknown> => {
		const pool = poolOf(endpoint)
		const token = await pool.take(abortSignal)
		const id = `call-${idPrefix}-${String(++callCount)}`
		channel.send({ type: 'call', id, endpoint: endpoint.id, token, call: gatewayCall })
		// Whether the answer was taken already, so a stop that comes after it doesn't wait for it again.
		const progress = { taken: false }
		const answered = channel.take(id, AbortSignal.any([abortSignal, runAbortSignal])).then((answer) => {
			progress.taken = true
			const parsed = CallAnswer.parse(answer.value)
			if (parsed.next !== undefined) pool.give(parsed.next)
			return parsed
		})
		try {
			const { outcome } = await answered
			if (!outcome.ok) throw new GatewayCallError(outcome.error, { transient: outcome.transient === true })
			return outcome.result
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

	return Object.freeze<GatewayClient>({
		run,
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
	})
}
