import type { Gateway } from '@mesh-flow/gateway'
import type { Answer } from '@mesh-flow/protocol'
import type { GatewayChannel } from '../../src/gateway/gateway-client.mts'

/**
 * A channel straight to a gateway in this process, as the engine would carry the calls: each call
 * is accepted, answered and settled, and a cancel stops the call it names.
 */
export function gatewayChannel(gateway: Gateway, runId: string, lifetime: AbortSignal): GatewayChannel {
	const answers = new Map<string, PromiseWithResolvers<Answer>>()
	const running = new Map<string, AbortController>()
	const slot = (id: string) => {
		const known = answers.get(id)
		if (known !== undefined) return known
		const created = Promise.withResolvers<Answer>()
		created.promise.catch(() => undefined)
		answers.set(id, created)
		return created
	}
	const answer = async (message: { readonly id: string } & Parameters<Gateway['accept']>[1]) => {
		const stop = new AbortController()
		running.set(message.id, stop)
		const accepted = await gateway.accept(runId, message, lifetime)
		const value = await accepted.answer(AbortSignal.any([stop.signal, lifetime]))
		await gateway.settle(runId, message.id, lifetime)
		running.delete(message.id)
		slot(message.id).resolve({ value })
	}
	return {
		send(message) {
			if (message.type === 'cancel') running.get(message.id)?.abort(new Error('The runtime cancelled the call.'))
			if (message.type !== 'call') return
			answer(message).catch((error: unknown) => {
				slot(message.id).reject(error)
			})
		},
		async take(requestId, abortSignal) {
			abortSignal.throwIfAborted()
			const { promise } = slot(requestId)
			const taken = await new Promise<Answer>((resolve, reject) => {
				abortSignal.addEventListener('abort', () => {
					reject(abortSignal.reason)
				})
				promise.then(resolve, reject)
			})
			answers.delete(requestId)
			return taken
		},
	}
}
