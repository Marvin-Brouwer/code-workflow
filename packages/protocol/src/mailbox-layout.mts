import path from 'node:path'

/**
 * Where the mailbox lives in the sandbox. The runtime appends to `outbox.jsonl`, the engine writes
 * answers to `inbox/<request id>.json`, and what to start, the runtime's pid and its log sit next to
 * them.
 *
 * Paths are POSIX, because the sandbox is Linux whatever the host is.
 */
export interface MailboxLayout {
	readonly directory: string
	/** The runtime appends one message per line here. */
	readonly outbox: string
	/** The engine writes its answers here, one file per request: see {@link answerFile}. */
	readonly inbox: string
	/** What the runtime is to do, written by the engine before it starts the runtime: a `RunStart`. */
	readonly startFile: string
	/** Where each running poll keeps its pid. */
	readonly polls: string
	/** The runtime's pid, so a poll sees it die. */
	readonly pidFile: string
	/** The runtime's stdout and stderr. */
	readonly logFile: string
	/**
	 * The run's gateway endpoint and its tokens, an `EndpointGrant`, written by the engine before it
	 * starts the runtime. The runtime removes it once it has read it.
	 */
	readonly grantFile: string
}

/** The layout of a mailbox in `directory`. */
export function mailboxLayout(directory: string): MailboxLayout {
	return Object.freeze({
		directory,
		outbox: path.posix.join(directory, 'outbox.jsonl'),
		inbox: path.posix.join(directory, 'inbox'),
		startFile: path.posix.join(directory, 'start.json'),
		polls: path.posix.join(directory, 'polls'),
		pidFile: path.posix.join(directory, 'runtime.pid'),
		logFile: path.posix.join(directory, 'runtime.log'),
		grantFile: path.posix.join(directory, 'gateway.json'),
	})
}

/** The file that holds the answer to one request. */
export function answerFile(layout: MailboxLayout, requestId: string): string {
	return path.posix.join(layout.inbox, `${requestId}.json`)
}

/** The default mailbox directory in a sandbox. */
export const defaultMailboxDirectory = '/var/lib/mesh-flow/mailbox'

/** Tells the runtime where its mailbox is. */
export const mailboxEnvironmentVariable = 'MESH_FLOW_MAILBOX'

/** Tells the runtime which run it is. */
export const runIdEnvironmentVariable = 'MESH_FLOW_RUN_ID'
