import { duration } from '@mesh-flow/duration'
import {
	answerFile,
	mailboxEnvironmentVariable,
	mailboxLayout,
	RuntimeMessage,
	stagedFile,
	type Answer,
	type MailboxLayout,
	type RunGrant,
	type RunStart,
} from '@mesh-flow/protocol'
import { temporaryFileOf, type Command, type Sandbox } from '@mesh-flow/sandbox'
import { pollInterval, pollScript, runtimeGoneExitCode, stopPollsScript } from './poll-script.mts'

/** What one poll of the outbox found. */
export type Delivery =
	| { readonly kind: 'messages'; readonly messages: readonly RuntimeMessage[]; readonly cursor: number }
	| { readonly kind: 'gone' }

/** How the runtime starts: where, with what environment, and the signal bounding the start. */
export interface StartRuntimeOptions {
	readonly signal: AbortSignal
	readonly cwd: string
	readonly env: Readonly<Record<string, string>>
}

/** How long one poll waits for news, so a poll is a short call and not an open connection. */
const longestPoll = duration.of('20s')

/** How many lines of the runtime's log go into an error message. */
export const tailLines = 20

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
		this.#layout = mailboxLayout(directory)
	}

	/** Makes the mailbox, readable for the runtime's user only. */
	async prepare(abortSignal: AbortSignal): Promise<void> {
		await this.#run(['mkdir', '-p', this.#layout.inbox, this.#layout.staged], abortSignal)
		await this.#run(['chmod', '700', this.#layout.directory], abortSignal)
	}

	/** Tells the runtime what to do. Written before it starts, and never again. */
	async writeStart(start: RunStart, abortSignal: AbortSignal): Promise<void> {
		await this.#sandbox.writeFile(this.#layout.startFile, JSON.stringify(start), abortSignal)
	}

	/** Hands the runtime the run's gateway endpoint. Written before it starts; the runtime removes it once read. */
	async writeGrant(grant: RunGrant, abortSignal: AbortSignal): Promise<void> {
		await this.#sandbox.writeFile(this.#layout.grantFile, JSON.stringify(grant), abortSignal)
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
	 * Waits up to {@link longestPoll} for messages after the first `cursor` lines. A line still
	 * being written is left for the next poll.
	 */
	async poll(cursor: number, signal: AbortSignal): Promise<Delivery> {
		const tries = String(longestPoll.to('ms') / pollInterval.to('ms'))
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

	/** Stages a body a call fetched, such as a package, where its answer tells the runtime to look. */
	async stage(name: string, body: Uint8Array, abortSignal: AbortSignal): Promise<void> {
		await this.#sandbox.writeFile(stagedFile(this.#layout, name), body, abortSignal)
	}

	/**
	 * Removes what was staged under `names`, also a write of it that was cut short, for calls whose
	 * answer will never name it: nothing in the sandbox would read it.
	 */
	async unstage(names: readonly string[], abortSignal: AbortSignal): Promise<void> {
		if (names.length === 0) return
		const files = names.map((name) => stagedFile(this.#layout, name))
		await this.#run(['rm', '-f', '--', ...files.flatMap((file) => [file, temporaryFileOf(file)])], abortSignal)
	}

	/** Writes the answer to a request where the runtime looks for it. */
	async answer(requestId: string, reply: Answer, signal: AbortSignal): Promise<void> {
		await this.#sandbox.writeFile(answerFile(this.#layout, requestId), JSON.stringify(reply), signal)
	}

	/** The end of the runtime's log, for an error message. */
	async logTail(signal: AbortSignal): Promise<string> {
		const result = await this.#sandbox.exec(['tail', '-n', String(tailLines), this.#layout.logFile], { signal })
		return result.stdout.trim()
	}

	async #run(command: Command, signal: AbortSignal): Promise<void> {
		const result = await this.#sandbox.exec(command, { signal })
		if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed in the sandbox: ${result.stderr.trim()}`)
	}
}

/** One line of the outbox as a message. `lineNumber` counts from 1, for the error. */
function parseLine(line: string, lineNumber: number): RuntimeMessage {
	try {
		return RuntimeMessage.parse(JSON.parse(line))
	} catch (error) {
		throw new Error(`Line ${String(lineNumber)} of the runtime's outbox isn't a valid message.`, { cause: error })
	}
}
