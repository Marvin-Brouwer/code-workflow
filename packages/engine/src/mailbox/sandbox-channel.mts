import type { Command, Sandbox } from '@mesh-flow/sandbox'
import type { Answer } from '../protocol/runtime-message.mts'
import { RuntimeMessage } from '../protocol/runtime-message.mts'
import { MailboxLayout, mailboxEnvironmentVariable } from './mailbox-layout.mts'
import { pollScript, runtimeGoneExitCode, stopPollsScript } from './poll-script.mts'

/** What one poll of the outbox found. */
export type Delivery =
	| { readonly kind: 'messages'; readonly messages: readonly RuntimeMessage[]; readonly cursor: number }
	| { readonly kind: 'gone' }

export interface StartRuntimeOptions {
	readonly signal: AbortSignal
	readonly cwd: string
	readonly env: Readonly<Record<string, string>>
}

/** How long one poll waits for news, so a poll is a short call and not an open connection. */
const pollSeconds = 20

/**
 * The engine's side of the mailbox in one sandbox. Every call is a short call into the sandbox
 * that the engine starts, so nothing in the sandbox needs to reach the host, and nothing stays
 * open across a pause: abort the poll, then pause.
 */
export class SandboxChannel {
	readonly #sandbox: Sandbox
	readonly #layout: MailboxLayout

	constructor(sandbox: Sandbox, directory: string) {
		this.#sandbox = sandbox
		this.#layout = new MailboxLayout(directory)
	}

	/** Makes the mailbox, readable for the runtime's user only. */
	async prepare(signal: AbortSignal): Promise<void> {
		await this.#run(['mkdir', '-p', this.#layout.inbox], signal)
		await this.#run(['chmod', '700', this.#layout.directory], signal)
	}

	/** Starts the runtime in the background. Its pid goes to the mailbox, so a poll sees it die. */
	async startRuntime(command: Command, options: StartRuntimeOptions): Promise<void> {
		const recordPid = 'pidFile=$1; shift; echo $$ > "$pidFile"; exec "$@"'
		await this.#sandbox.startInBackground(['sh', '-c', recordPid, 'sh', this.#layout.pidFile, ...command], {
			signal: options.signal,
			cwd: options.cwd,
			env: { ...options.env, [mailboxEnvironmentVariable]: this.#layout.directory },
			logFile: this.#layout.logFile,
		})
	}

	/**
	 * Waits up to {@link pollSeconds} for messages after the first `cursor` lines. A line still
	 * being written is left for the next poll.
	 */
	async poll(cursor: number, signal: AbortSignal): Promise<Delivery> {
		const tries = String(pollSeconds * 4)
		const { outbox, pidFile, polls } = this.#layout
		const command: Command = ['sh', '-c', pollScript, 'sh', outbox, pidFile, String(cursor), tries, polls]
		const result = await this.#sandbox.exec(command, { signal })
		if (result.exitCode === runtimeGoneExitCode) return { kind: 'gone' }
		if (result.exitCode !== 0) throw new Error(`Reading the runtime's outbox failed (${String(result.exitCode)}): ${result.stderr.trim()}`)
		const lines = result.stdout.split('\n').slice(0, -1)
		const messages = lines.map((line, index) => parseLine(line, cursor + index + 1))
		return { kind: 'messages', messages, cursor: cursor + lines.length }
	}

	/**
	 * Ends every poll still running in the sandbox, so nothing an exec started is left in it.
	 * Call it after aborting the poll and before pausing the sandbox.
	 */
	async stopPolls(signal: AbortSignal): Promise<void> {
		await this.#run(['sh', '-c', stopPollsScript, 'sh', this.#layout.polls], signal)
	}

	async answer(requestId: string, answer: Answer, signal: AbortSignal): Promise<void> {
		await this.#sandbox.writeFile(this.#layout.answer(requestId), JSON.stringify(answer), signal)
	}

	/** The end of the runtime's log, for an error message. */
	async logTail(signal: AbortSignal): Promise<string> {
		const result = await this.#sandbox.exec(['tail', '-n', '20', this.#layout.logFile], { signal })
		return result.stdout.trim()
	}

	async #run(command: Command, signal: AbortSignal): Promise<void> {
		const result = await this.#sandbox.exec(command, { signal })
		if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed in the sandbox: ${result.stderr.trim()}`)
	}
}

function parseLine(line: string, number: number): RuntimeMessage {
	try {
		return RuntimeMessage.parse(JSON.parse(line))
	} catch (error) {
		throw new Error(`Line ${String(number)} of the runtime's outbox isn't a valid message.`, { cause: error })
	}
}
