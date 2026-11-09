import { appendFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Answer, RuntimeMessage } from './runtime-message.mts'
import { answerFile, mailboxEnvironmentVariable, mailboxLayout, type MailboxLayout } from './mailbox-layout.mts'

/** How often the runtime looks for an answer. Only a polling interval, never a wall-clock wait. */
const answerPollMs = 250

/**
 * The runtime's side of the mailbox, used inside the sandbox. It sends messages by appending a
 * line to the outbox and picks up answers from the inbox. It holds no connection, so a pause
 * can't break it.
 *
 * Node built-ins only: this runs in the sandbox next to the workflow.
 */
export class RuntimeMailbox {
	readonly #layout: MailboxLayout
	readonly #requested = new Set<string>()

	constructor(directory: string) {
		this.#layout = mailboxLayout(directory)
	}

	/** The mailbox the engine started this process with. */
	static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): RuntimeMailbox {
		const directory = environment[mailboxEnvironmentVariable]
		if (!directory) throw new Error(`${mailboxEnvironmentVariable} isn't set: this process wasn't started by the mesh-flow engine.`)
		return new RuntimeMailbox(directory)
	}

	/**
	 * Appends one message as one line. A single append of a line is one write, so the engine never
	 * reads half of it as a whole message.
	 *
	 * A request id is used once per run attempt: its answer stays in the inbox, so asking again
	 * under the same id would get the old answer. Sending it twice throws.
	 */
	send(message: RuntimeMessage): void {
		const requestId = requestIdOf(message)
		if (requestId !== undefined) this.#assertUnused(requestId)
		appendFileSync(this.#layout.outbox, `${JSON.stringify(message)}\n`)
		// Claimed once it's sent, so a send that failed can be tried again with the same id.
		if (requestId !== undefined) this.#requested.add(requestId)
	}

	/** Refuses a request id that was sent already, because it would get the old answer. */
	#assertUnused(requestId: string): void {
		if (this.#requested.has(requestId)) throw new Error(`Request ${requestId} was sent already. Use a new id for every request.`)
	}

	/** What the engine started the runtime to do, as JSON: check it with `RunStart`. */
	async readStart(abortSignal: AbortSignal): Promise<unknown> {
		const parsed: unknown = JSON.parse(await readFile(this.#layout.startFile, { encoding: 'utf8', signal: abortSignal }))
		return parsed
	}

	/**
	 * The run's gateway endpoint and its tokens, as JSON: check it with `EndpointGrant`. Removed once
	 * it's read, so the tokens are only in the runtime's memory. `undefined` when the engine wrote
	 * none, because it has no gateway.
	 */
	async takeGateway(abortSignal: AbortSignal): Promise<unknown> {
		const text = await readFile(this.#layout.gatewayFile, { encoding: 'utf8', signal: abortSignal }).catch((error: unknown) => {
			if (isMissing(error)) return undefined
			throw error
		})
		if (text === undefined) return undefined
		await rm(this.#layout.gatewayFile, { force: true })
		const parsed: unknown = JSON.parse(text)
		return parsed
	}

	/**
	 * Waits for the answer to a call, then removes it from the inbox: it holds the endpoint's next
	 * token, which belongs in the runtime's memory only.
	 */
	async take(requestId: string, abortSignal: AbortSignal): Promise<Answer> {
		const answer = await this.answer(requestId, abortSignal)
		await rm(answerFile(this.#layout, requestId), { force: true })
		return answer
	}

	/** Waits until the engine has answered the request with this id. */
	async answer(requestId: string, abortSignal: AbortSignal): Promise<Answer> {
		const file = answerFile(this.#layout, requestId)
		for (;;) {
			abortSignal.throwIfAborted()
			const text = await readFile(file, 'utf8').catch((error: unknown) => {
				if (isMissing(error)) return undefined
				throw error
			})
			if (text !== undefined) return toAnswer(JSON.parse(text))
			// `delay` rejects with a plain AbortError; the signal's reason says why the wait stopped.
			await delay(answerPollMs, undefined, { signal: abortSignal }).catch(() => {
				abortSignal.throwIfAborted()
			})
		}
	}
}

/** The id a message waits for an answer under: a request's or a call's. */
function requestIdOf(message: RuntimeMessage): string | undefined {
	if (message.type === 'request') return message.request.id
	if (message.type === 'call') return message.id
	return undefined
}

/** The engine writes `{ value }`, or `{}` for a wake. */
function toAnswer(parsed: unknown): Answer {
	return typeof parsed === 'object' && parsed !== null && 'value' in parsed ? { value: parsed.value } : {}
}

/** Kept here rather than shared with the engine, because this file may only use Node built-ins. */
function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
