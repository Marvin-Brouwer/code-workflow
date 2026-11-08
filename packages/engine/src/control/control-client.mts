import { request } from 'node:http'
import { RuntimeEvent } from '@mesh-flow/protocol'
import { hasErrorCode } from '../error-code.mts'
import { z } from 'zod'
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

/** Talks to a running engine over its control socket, for the CLI. */
export class ControlClient {
	readonly #socketPath: string

	constructor(socketPath: string) {
		this.#socketPath = socketPath
	}

	list(signal: AbortSignal): Promise<RunRecord[]> {
		return this.#call(z.array(RunRecord), 'GET', '/runs', undefined, signal)
	}

	get(run: string, signal: AbortSignal): Promise<RunRecord> {
		return this.#call(RunRecord, 'GET', `/runs/${encodeURIComponent(run)}`, undefined, signal)
	}

	events(run: string, signal: AbortSignal): Promise<RuntimeEvent[]> {
		return this.#call(z.array(RuntimeEvent), 'GET', `/runs/${encodeURIComponent(run)}/events`, undefined, signal)
	}

	startRun(directory: string, workflow: string, signal: AbortSignal): Promise<RunRecord> {
		return this.#call(RunRecord, 'POST', '/runs', { directory, workflow }, signal)
	}

	answer(run: string, requestId: string, value: unknown, signal: AbortSignal): Promise<RunRecord> {
		return this.#call(RunRecord, 'POST', `/runs/${encodeURIComponent(run)}/answers/${encodeURIComponent(requestId)}`, { value }, signal)
	}

	act(run: string, action: 'stop' | 'resume' | 'restart', signal: AbortSignal): Promise<RunRecord> {
		return this.#call(RunRecord, 'POST', `/runs/${encodeURIComponent(run)}/${action}`, {}, signal)
	}

	#call<T>(schema: z.ZodType<T>, method: string, route: string, body: unknown, signal: AbortSignal): Promise<T> {
		const payload = body === undefined ? undefined : JSON.stringify(body)
		return new Promise<T>((resolve, reject) => {
			const outgoing = request(
				{
					socketPath: this.#socketPath,
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
						const parsed = parse(Buffer.concat(chunks).toString('utf8'))
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
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function errorOf(body: unknown): string | undefined {
	return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : undefined
}
