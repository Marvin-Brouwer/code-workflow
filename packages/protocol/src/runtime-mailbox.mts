import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Answer, RuntimeMessage } from './runtime-message.mts'
import { MailboxLayout, mailboxEnvironmentVariable } from './mailbox-layout.mts'

/** How often the runtime looks for an answer. Only a polling interval, never a wall-clock wait. */
const answerPollMs = 250

/**
 * The runtime's side of the mailbox, used inside the sandbox. It sends messages by appending a
 * line to the outbox and picks up answers from the inbox. It holds no connection, so a pause
 * can't break it.
 *
 * Node built-ins only: this runs in the sandbox next to the workflow.
 */
/** The engine writes `{ value }`, or `{}` for a wake. */
function toAnswer(parsed: unknown): Answer {
	return typeof parsed === 'object' && parsed !== null && 'value' in parsed ? { value: parsed.value } : {}
}

export class RuntimeMailbox {
	readonly #layout: MailboxLayout

	constructor(directory: string) {
		this.#layout = new MailboxLayout(directory)
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
	 */
	send(message: RuntimeMessage): void {
		appendFileSync(this.#layout.outbox, `${JSON.stringify(message)}\n`)
	}

	/** Waits until the engine has answered the request with this id. */
	async answer(requestId: string, signal: AbortSignal): Promise<Answer> {
		const file = this.#layout.answer(requestId)
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

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
