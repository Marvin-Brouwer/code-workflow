import { request } from 'node:http'
import type { Readable } from 'node:stream'
import { MissingSetting } from '@mesh-flow/gateway'
import { AppManifest, RuntimeEvent, type TriggerReference } from '@mesh-flow/protocol'
import { z } from 'zod'
import { SignInState } from '../engine/sign-in-state.mts'
import { hasErrorCode } from '../errors.mts'
import { RunRecord } from '../runs/run-record.mts'
import { ShownConnector } from './shown-connector.mts'

/** The deployed app as the control API shows it: its current version and what that declares. */
export const DeployedApp = z.object({ version: z.string(), manifest: AppManifest })
export type DeployedApp = z.infer<typeof DeployedApp>

/** What a deploy answers: the app, and the settings the engine still needs before it can run. */
export const DeployOutcome = DeployedApp.extend({ missing: z.array(MissingSetting) })
export type DeployOutcome = z.infer<typeof DeployOutcome>

/** Thrown when the engine refused a request or isn't running. */
export class ControlError extends Error {
	/** What the engine answered. `undefined` when no engine is running. */
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
	/** Starts a run through one of the app's triggers, with its parameters or a webhook's payload. Without them, a schedule runs with its own. */
	startRun(options: {
		readonly trigger: TriggerReference
		readonly input?: unknown
		/** Names the start, so sending it again returns the run it started instead of a second one. */
		readonly key?: string | undefined
		readonly abortSignal: AbortSignal
	}): Promise<RunRecord>
	answer(run: string, requestId: string, value: unknown, abortSignal: AbortSignal): Promise<RunRecord>
	stop(run: string, abortSignal: AbortSignal): Promise<RunRecord>
	resume(run: string, abortSignal: AbortSignal): Promise<RunRecord>
	restart(run: string, abortSignal: AbortSignal): Promise<RunRecord>
	/**
	 * The engine's event stream, as server-sent events (see `GET /events`), once the engine
	 * answered. It ends when the engine closes or `abortSignal` aborts.
	 */
	followEngine(abortSignal: AbortSignal): Promise<Readable>
	/**
	 * One run's event stream, as server-sent events (see `GET /runs/:run/events`), once the engine
	 * answered. With `lastEventId`, only the events after it. It ends when the engine closes, the
	 * run is removed or `abortSignal` aborts.
	 */
	followRun(run: string, options: { readonly lastEventId?: string | undefined; readonly abortSignal: AbortSignal }): Promise<Readable>
	/** The connectors the engine loaded, and whether each signs in. */
	connectors(abortSignal: AbortSignal): Promise<ShownConnector[]>
	/** The sign-ins under way, with where to sign in. */
	signIns(abortSignal: AbortSignal): Promise<SignInState[]>
	/** Waits until the user signed in to `connector`, joining the sign-in runs wait for. */
	waitForSignIn(connector: string, abortSignal: AbortSignal): Promise<void>
	/** The deployed app's current version, or nothing before the first deploy. */
	app(abortSignal: AbortSignal): Promise<DeployedApp | undefined>
	/** The settings the app's current version still needs before it can run. Empty when it can. */
	missingSettings(abortSignal: AbortSignal): Promise<MissingSetting[]>
	/** Deploys the built app packed in `tarball`, on this machine, as the new current version. */
	deploy(tarball: string, abortSignal: AbortSignal): Promise<DeployOutcome>
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
		startRun: ({ trigger, input, key, abortSignal }) => call(socketPath, RunRecord, 'POST', '/runs', { trigger, input, key }, abortSignal),
		answer: (run, requestId, value, abortSignal) =>
			call(socketPath, RunRecord, 'POST', `${runPath(run)}/answers/${encodeURIComponent(requestId)}`, { value }, abortSignal),
		stop: act('stop'),
		resume: act('resume'),
		restart: act('restart'),
		followEngine: (abortSignal) => openStream(socketPath, '/events', {}, abortSignal),
		followRun: (run, { lastEventId, abortSignal }) =>
			openStream(socketPath, `${runPath(run)}/events`, runStreamHeaders(lastEventId), abortSignal),
		connectors: (abortSignal) => call(socketPath, z.array(ShownConnector), 'GET', '/connectors', undefined, abortSignal),
		signIns: (abortSignal) => call(socketPath, z.array(SignInState), 'GET', '/sign-ins', undefined, abortSignal),
		waitForSignIn: async (connector, abortSignal) => {
			await call(socketPath, z.object({ signedIn: z.string() }), 'POST', `/sign-ins/${encodeURIComponent(connector)}`, {}, abortSignal)
		},
		app: async (abortSignal) => (await call(socketPath, DeployedApp.nullable(), 'GET', '/app', undefined, abortSignal)) ?? undefined,
		missingSettings: (abortSignal) => call(socketPath, z.array(MissingSetting), 'GET', '/app/missing', undefined, abortSignal),
		deploy: (tarball, abortSignal) => call(socketPath, DeployOutcome, 'PUT', '/app', { tarball }, abortSignal),
	} satisfies ControlClient)
}

/** The headers that ask for a run's stream, from after `lastEventId` when there is one. */
function runStreamHeaders(lastEventId: string | undefined): Record<string, string> {
	if (lastEventId === undefined) return { accept: 'text/event-stream' }
	return { accept: 'text/event-stream', 'last-event-id': lastEventId }
}

/** One request to the control API, with the response checked against `schema`. */
function call<Result>(
	socketPath: string,
	schema: z.ZodType<Result>,
	method: string,
	route: string,
	body: unknown,
	abortSignal: AbortSignal,
): Promise<Result> {
	const payload = body === undefined ? undefined : JSON.stringify(body)
	return new Promise<Result>((resolve, reject) => {
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
			reject(notRunningOr(error))
		})
		outgoing.end(payload)
	})
}

/** A streamed answer of the control API, once the engine answered 200. */
function openStream(socketPath: string, route: string, headers: Record<string, string>, abortSignal: AbortSignal): Promise<Readable> {
	return new Promise<Readable>((resolve, reject) => {
		const outgoing = request({ socketPath, path: route, method: 'GET', headers, signal: abortSignal }, (response) => {
			if (response.statusCode === 200) {
				resolve(response)
				return
			}
			const chunks: Buffer[] = []
			response.on('data', (chunk: Buffer) => chunks.push(chunk))
			response.on('error', reject)
			response.on('end', () => {
				const parsed = parseJsonOrUndefined(Buffer.concat(chunks).toString('utf8'))
				reject(new ControlError(errorOf(parsed) ?? `The engine answered ${String(response.statusCode ?? 0)}.`, response.statusCode))
			})
		})
		outgoing.on('error', (error) => {
			reject(notRunningOr(error))
		})
		outgoing.end()
	})
}

/** A failed connection as the error a caller gets: no engine running, when there's no socket to reach. */
function notRunningOr(error: Error): Error {
	return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ECONNREFUSED')
		? new ControlError('No engine is running. Start one with `mesh-flow serve`.')
		: error
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
