import { request } from 'node:http'
import { AppManifest, RuntimeEvent, type TriggerRef } from '@mesh-flow/protocol'
import { z } from 'zod'
import { hasErrorCode } from '../errors.mts'
import { RunRecord } from '../runs/run-record.mts'

/** A deployed app as the control API shows it: its current version and what that declares. */
export const DeployedApp = z.object({ name: z.string(), version: z.string(), manifest: AppManifest })
export type DeployedApp = z.infer<typeof DeployedApp>

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
	list(abortSignal: AbortSignal): Promise<RunRecord[]>
	get(run: string, abortSignal: AbortSignal): Promise<RunRecord>
	/** The run's events, in the order the runtime sent them. */
	events(run: string, abortSignal: AbortSignal): Promise<RuntimeEvent[]>
	/** Starts a run through one of an app's triggers, with its parameters or a webhook's payload. Without them, a schedule runs with its own. */
	startRun(options: {
		readonly app: string
		readonly trigger: TriggerRef
		readonly input?: unknown
		readonly abortSignal: AbortSignal
	}): Promise<RunRecord>
	answer(run: string, requestId: string, value: unknown, abortSignal: AbortSignal): Promise<RunRecord>
	stop(run: string, abortSignal: AbortSignal): Promise<RunRecord>
	resume(run: string, abortSignal: AbortSignal): Promise<RunRecord>
	restart(run: string, abortSignal: AbortSignal): Promise<RunRecord>
	/** Every deployed app's current version. */
	apps(abortSignal: AbortSignal): Promise<DeployedApp[]>
	/** Deploys the built app packed in `tarball`, on this machine, as the new current version of `name`. */
	deploy(name: string, tarball: string, abortSignal: AbortSignal): Promise<DeployedApp>
	removeApp(name: string, abortSignal: AbortSignal): Promise<void>
}

/** The route of one run. */
function runPath(run: string): string {
	return `/runs/${encodeURIComponent(run)}`
}

/** A client for the engine that serves on `socketPath`. */
export function controlClient(socketPath: string): ControlClient {
	const act = (action: 'stop' | 'resume' | 'restart') => (run: string, abortSignal: AbortSignal) =>
		call(socketPath, RunRecord, 'POST', `${runPath(run)}/${action}`, {}, abortSignal)
	return Object.freeze({
		list: (abortSignal) => call(socketPath, z.array(RunRecord), 'GET', '/runs', undefined, abortSignal),
		get: (run, abortSignal) => call(socketPath, RunRecord, 'GET', runPath(run), undefined, abortSignal),
		events: (run, abortSignal) => call(socketPath, z.array(RuntimeEvent), 'GET', `${runPath(run)}/events`, undefined, abortSignal),
		startRun: ({ app, trigger, input, abortSignal }) => call(socketPath, RunRecord, 'POST', '/runs', { app, trigger, input }, abortSignal),
		answer: (run, requestId, value, abortSignal) =>
			call(socketPath, RunRecord, 'POST', `${runPath(run)}/answers/${encodeURIComponent(requestId)}`, { value }, abortSignal),
		stop: act('stop'),
		resume: act('resume'),
		restart: act('restart'),
		apps: (abortSignal) => call(socketPath, z.array(DeployedApp), 'GET', '/apps', undefined, abortSignal),
		deploy: (name, tarball, abortSignal) =>
			call(socketPath, DeployedApp, 'PUT', `/apps/${encodeURIComponent(name)}`, { tarball }, abortSignal),
		removeApp: async (name, abortSignal) => {
			await call(socketPath, z.unknown(), 'DELETE', `/apps/${encodeURIComponent(name)}`, undefined, abortSignal)
		},
	} satisfies ControlClient)
}

/** One request to the control API, with the response checked against `schema`. */
function call<T>(
	socketPath: string,
	schema: z.ZodType<T>,
	method: string,
	route: string,
	body: unknown,
	abortSignal: AbortSignal,
): Promise<T> {
	const payload = body === undefined ? undefined : JSON.stringify(body)
	return new Promise<T>((resolve, reject) => {
		const outgoing = request(
			{
				socketPath,
				path: route,
				method,
				signal: abortSignal,
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
