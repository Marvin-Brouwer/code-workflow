import type { Answer, RuntimeMessage } from '@mesh-flow/protocol'

/**
 * How a run talks to the engine: it sends messages and waits for answers. Under the engine this is
 * the sandbox's mailbox (`RuntimeMailbox` from `@mesh-flow/protocol`); tests pass one of their own.
 */
export interface RunChannel {
	/** Sends one message. A request id is used once per run attempt. */
	send(message: RuntimeMessage): void
	/** Waits until the engine has answered the request with this id. */
	answer(requestId: string, signal: AbortSignal): Promise<Answer>
}
