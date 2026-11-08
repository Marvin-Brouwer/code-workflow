import path from 'node:path'

/**
 * Where the mailbox lives in the sandbox. The runtime appends to `outbox.jsonl`, the engine writes
 * answers to `inbox/<request id>.json`, and the runtime's pid and log sit next to them.
 *
 * Paths are POSIX, because the sandbox is Linux whatever the host is.
 */
export class MailboxLayout {
	readonly directory: string

	constructor(directory: string) {
		this.directory = directory
	}

	/** The runtime appends one message per line here. */
	get outbox(): string {
		return path.posix.join(this.directory, 'outbox.jsonl')
	}

	/** The engine writes its answers here. */
	get inbox(): string {
		return path.posix.join(this.directory, 'inbox')
	}

	/** The answer to one request. */
	answer(requestId: string): string {
		return path.posix.join(this.inbox, `${requestId}.json`)
	}

	/** Where each running poll keeps its pid. */
	get polls(): string {
		return path.posix.join(this.directory, 'polls')
	}

	/** The runtime's pid, so a poll sees it die. */
	get pidFile(): string {
		return path.posix.join(this.directory, 'runtime.pid')
	}

	/** The runtime's stdout and stderr. */
	get logFile(): string {
		return path.posix.join(this.directory, 'runtime.log')
	}
}

/** The default mailbox directory in a sandbox. */
export const defaultMailboxDirectory = '/var/lib/mesh-flow/mailbox'

/** Tells the runtime where its mailbox is. */
export const mailboxEnvironmentVariable = 'MESH_FLOW_MAILBOX'

/** Tells the runtime which run it is. */
export const runIdEnvironmentVariable = 'MESH_FLOW_RUN_ID'
