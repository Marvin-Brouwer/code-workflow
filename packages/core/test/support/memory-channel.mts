import type { Answer, InputRequest, RuntimeEvent, RuntimeMessage } from '@mesh-flow/protocol'
import type { RunChannel } from '../../src/run/run-channel.mts'

/** A channel in memory: it keeps what the run sends, and the test answers requests through `reply`. */
export interface MemoryChannel extends RunChannel {
	readonly messages: readonly RuntimeMessage[]
	readonly events: readonly RuntimeEvent[]
	/** The input requests sent so far. */
	readonly inputs: readonly InputRequest[]
	/** Resolves with the next input request the run sends, or one it sent already and nobody answered. */
	nextInput(): Promise<InputRequest>
	/** Answers a request. */
	reply(requestId: string, value: unknown): void
}

export function memoryChannel(): MemoryChannel {
	const messages: RuntimeMessage[] = []
	const answers = new Map<string, PromiseWithResolvers<Answer>>()
	const unanswered: InputRequest[] = []
	const waiting: ((request: InputRequest) => void)[] = []
	const slot = (id: string) => {
		const known = answers.get(id)
		if (known !== undefined) return known
		const created = Promise.withResolvers<Answer>()
		answers.set(id, created)
		return created
	}
	return {
		messages,
		get events() {
			return messages.flatMap((message) => (message.type === 'event' ? [message.event] : []))
		},
		get inputs() {
			return messages.flatMap((message) => (message.type === 'request' && message.request.kind === 'input' ? [message.request] : []))
		},
		send(message) {
			messages.push(message)
			if (message.type !== 'request' || message.request.kind !== 'input') return
			const next = waiting.shift()
			if (next === undefined) unanswered.push(message.request)
			else next(message.request)
		},
		async answer(requestId, abortSignal) {
			const { promise } = slot(requestId)
			abortSignal.throwIfAborted()
			return new Promise((resolve, reject) => {
				abortSignal.addEventListener('abort', () => {
					reject(abortSignal.reason)
				})
				promise.then(resolve, reject)
			})
		},
		nextInput() {
			const ready = unanswered.shift()
			if (ready !== undefined) return Promise.resolve(ready)
			return new Promise((resolve) => waiting.push(resolve))
		},
		reply(requestId, value) {
			slot(requestId).resolve({ value })
		},
	}
}
