import { CallAnswer, EndpointGrant, type Answer, type GatewayCall, type RuntimeMessage } from '@mesh-flow/protocol'
import { TokenPool } from './token-pool.mts'

/** How the gateway client reaches the engine: the runtime's mailbox, or a test's own. */
export interface GatewayChannel {
	send(message: RuntimeMessage): void
	/** Waits for the answer to a call, then removes it, since it holds a token. */
	take(requestId: string, abortSignal: AbortSignal): Promise<Answer>
}

/** An endpoint on the gateway: its id, the host tools it takes, and its free tokens. */
export interface Endpoint {
	readonly id: string
	/** The host tools it takes. `undefined` for the run's own endpoint, which takes every tool the app lists. */
	readonly tools: ReadonlySet<string> | undefined
	readonly tokens: TokenPool
}

/** A call to the gateway failed on the host: refused, or the host tool or the provider failed. */
export class GatewayCallError extends Error {
	override readonly name = 'GatewayCallError'
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
 * A client on `channel` for the run's endpoint in `grant`. `lifetime` is the run's signal: a call
 * the caller stopped waiting for is cancelled on the host, and its answer, with the next token,
 * is still picked up until the run ends.
 */
export function gatewayClient(channel: GatewayChannel, grant: EndpointGrant, idPrefix: string, lifetime: AbortSignal): GatewayClient {
	let calls = 0
	const run: Endpoint = { id: grant.endpoint, tools: undefined, tokens: new TokenPool(grant.tokens) }

	const call = async (endpoint: Endpoint, gatewayCall: GatewayCall, abortSignal: AbortSignal): Promise<unknown> => {
		const token = await endpoint.tokens.take(abortSignal)
		const id = `call-${idPrefix}-${String(++calls)}`
		channel.send({ type: 'call', id, endpoint: endpoint.id, token, call: gatewayCall })
		// Whether the answer was taken already, so a stop that comes after it doesn't wait for it again.
		const progress = { taken: false }
		const answered = channel.take(id, AbortSignal.any([abortSignal, lifetime])).then((answer) => {
			progress.taken = true
			const parsed = CallAnswer.parse(answer.value)
			if (parsed.next !== undefined) endpoint.tokens.give(parsed.next)
			return parsed
		})
		try {
			const { outcome } = await answered
			if (!outcome.ok) throw new GatewayCallError(outcome.error)
			return outcome.result
		} catch (error) {
			if (progress.taken || !abortSignal.aborted || lifetime.aborted) throw error
			channel.send({ type: 'cancel', id })
			// The answer still comes, with the next token: the rest of the run needs it.
			const recovered = channel.take(id, lifetime).then((answer) => {
				const next = CallAnswer.safeParse(answer.value)
				if (next.success && next.data.next !== undefined) endpoint.tokens.give(next.data.next)
			})
			recovered.catch(() => undefined)
			throw error
		}
	}

	return {
		run,
		call,
		async openLoop(tools, abortSignal) {
			const opened = EndpointGrant.parse(await call(run, { type: 'open', tools: [...tools] }, abortSignal))
			return { id: opened.endpoint, tools: new Set(tools), tokens: new TokenPool(opened.tokens) }
		},
		async closeLoop(endpoint, abortSignal) {
			await call(run, { type: 'close', endpoint: endpoint.id }, abortSignal)
		},
	}
}
