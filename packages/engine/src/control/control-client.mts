import { request } from 'node:http'
import { RuntimeEvent, WorkflowsDescription } from '@mesh-flow/protocol'
import { z } from 'zod'
import { hasErrorCode } from '../errors.mts'
import { Repository } from '../repositories/repository-store.mts'
import { RunRecord } from '../runs/run-record.mts'

/** Thrown when the engine refused a request or isn't running. */
export class ControlError extends Error {
	readonly status: number | undefined

	constructor(message: string, status?: number) {
		super(message)
		this.name = 'ControlError'
		this.status = status
	}
}

/** Talks to a running engine over its control socket, for the CLI. Each call is one request. */
export interface ControlClient {
	list(signal: AbortSignal): Promise<RunRecord[]>
	get(run: string, signal: AbortSignal): Promise<RunRecord>
	/** The run's events, in the order the runtime sent them. */
	events(run: string, signal: AbortSignal): Promise<RuntimeEvent[]>
	startRun(options: {
		readonly directory: string
		readonly workflow: string
		readonly parameters?: unknown
		readonly abortSignal: AbortSignal
	}): Promise<RunRecord>
	answer(run: string, requestId: string, value: unknown, signal: AbortSignal): Promise<RunRecord>
	stop(run: string, signal: AbortSignal): Promise<RunRecord>
	resume(run: string, signal: AbortSignal): Promise<RunRecord>
	restart(run: string, signal: AbortSignal): Promise<RunRecord>
	/** What a repository's entry file declares, described in a sandbox. */
	describe(directory: string, abortSignal: AbortSignal): Promise<WorkflowsDescription>
	/** The repositories whose webhooks and schedules the engine serves. */
	repositories(abortSignal: AbortSignal): Promise<Repository[]>
	/** Registers a repository, or points a registered name at another directory. */
	addRepository(repository: Repository, abortSignal: AbortSignal): Promise<Repository>
	removeRepository(name: string, abortSignal: AbortSignal): Promise<void>
}

/** The route of one run. */
function runPath(run: string): string {
	return `/runs/${encodeURIComponent(run)}`
}

/** A client for the engine that serves on `socketPath`. */
export function controlClient(socketPath: string): ControlClient {
	const act = (action: 'stop' | 'resume' | 'restart') => (run: string, signal: AbortSignal) =>
		call(socketPath, RunRecord, 'POST', `${runPath(run)}/${action}`, {}, signal)
	return Object.freeze({
		list: (signal) => call(socketPath, z.array(RunRecord), 'GET', '/runs', undefined, signal),
		get: (run, signal) => call(socketPath, RunRecord, 'GET', runPath(run), undefined, signal),
		events: (run, signal) => call(socketPath, z.array(RuntimeEvent), 'GET', `${runPath(run)}/events`, undefined, signal),
		startRun: ({ directory, workflow, parameters, abortSignal }) =>
			call(socketPath, RunRecord, 'POST', '/runs', { directory, workflow, parameters }, abortSignal),
		answer: (run, requestId, value, signal) =>
			call(socketPath, RunRecord, 'POST', `${runPath(run)}/answers/${encodeURIComponent(requestId)}`, { value }, signal),
		stop: act('stop'),
		resume: act('resume'),
		restart: act('restart'),
		describe: (directory, abortSignal) => call(socketPath, WorkflowsDescription, 'POST', '/describe', { directory }, abortSignal),
		repositories: (abortSignal) => call(socketPath, z.array(Repository), 'GET', '/repositories', undefined, abortSignal),
		addRepository: ({ name, directory }, abortSignal) =>
			call(socketPath, Repository, 'PUT', `/repositories/${encodeURIComponent(name)}`, { directory }, abortSignal),
		removeRepository: async (name, abortSignal) => {
			await call(socketPath, z.unknown(), 'DELETE', `/repositories/${encodeURIComponent(name)}`, undefined, abortSignal)
		},
	} satisfies ControlClient)
}

/** One request to the control API, with the response checked against `schema`. */
function call<T>(socketPath: string, schema: z.ZodType<T>, method: string, route: string, body: unknown, signal: AbortSignal): Promise<T> {
	const payload = body === undefined ? undefined : JSON.stringify(body)
	return new Promise<T>((resolve, reject) => {
		const outgoing = request(
			{
				socketPath,
				path: route,
				method,
				signal,
				headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
			},
			(response) => {
				const chunks: Buffer[] = []
				response.on('data', (chunk: Buffer) => chunks.push(chunk))
				response.on('error', reject)
				response.on('end', () => {
					const status = response.statusCode ?? 0
					const parsed = parseJsonOrUndefined(Buffer.concat(chunks).toString('utf8'))
					if (status >= 200 && status < 300) resolve(schema.parse(parsed))
					else reject(new ControlError(errorOf(parsed) ?? `The engine answered ${String(status)}.`, status))
				})
			},
		)
		outgoing.on('error', (error) => {
			reject(
				hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ECONNREFUSED')
					? new ControlError('No engine is running. Start one with `mesh-flow serve`.')
					: error,
			)
		})
		outgoing.end(payload)
	})
}

/** The body as JSON, or `undefined` when it isn't JSON, such as an empty body. */
function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** The `error` message of an error body, if it has one. */
function errorOf(body: unknown): string | undefined {
	return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : undefined
}
