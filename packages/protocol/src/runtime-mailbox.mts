import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
		if (message.type === 'request') this.#claim(message.request.id)
		appendFileSync(this.#layout.outbox, `${JSON.stringify(message)}\n`)
	}

	/** Remembers a request id, because a reused id would get the old answer. */
	#claim(requestId: string): void {
		if (this.#requested.has(requestId)) throw new Error(`Request ${requestId} was sent already. Use a new id for every request.`)
		this.#requested.add(requestId)
	}

	/** Waits until the engine has answered the request with this id. */
	async answer(requestId: string, signal: AbortSignal): Promise<Answer> {
		const file = answerFile(this.#layout, requestId)
		for (;;) {
			signal.throwIfAborted()
			const text = await readFile(file, 'utf8').catch((error: unknown) => {
				if (isMissing(error)) return undefined
				throw error
			})
			if (text !== undefined) return toAnswer(JSON.parse(text))
			await delay(answerPollMs, undefined, { signal })
		}
	}
}

/** The engine writes `{ value }`, or `{}` for a wake. */
function toAnswer(parsed: unknown): Answer {
	return typeof parsed === 'object' && parsed !== null && 'value' in parsed ? { value: parsed.value } : {}
}

/** Kept here rather than shared with the engine, because this file may only use Node built-ins. */
function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
