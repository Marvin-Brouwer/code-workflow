import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { readTextIfExists } from '../files/read-text-if-exists.mts'
import { RunUsage } from '../providers/usage.mts'

/** One endpoint of a run: the tools it takes and the hashes of the tokens that work on it now. */
const EndpointState = z.object({
	/** A loop's endpoint takes only its tools; the run's takes everything the app may call. */
	loop: z.boolean(),
	tools: z.array(z.string()),
	tokens: z.array(z.string()),
})
export type EndpointState = z.infer<typeof EndpointState>

/** A call that was accepted and isn't answered yet, with the token its answer will carry. */
const InFlightCall = z.object({
	endpoint: z.string(),
	/** The hash of the token it was made with. */
	spent: z.string(),
	next: z.string(),
	/**
	 * Answered as interrupted after a resume. Kept, so that reading the call again from where the
	 * cursor was saved isn't taken for a stolen token.
	 */
	interrupted: z.boolean().default(false),
	/** Its interrupted answer is in the sandbox. Until the outbox is read past it, a read of it again gets the same. */
	answered: z.boolean().default(false),
})
export type InFlightCall = z.infer<typeof InFlightCall>

/**
 * What the gateway knows of one run, on disk so that a run paused across an engine restart can go
 * on calling. No token in it works: only their hashes are kept, besides the next tokens of calls
 * that weren't answered yet, which a restarted engine still has to hand over.
 */
export const RunState = z.object({
	/** The host tools the run's app may call. */
	tools: z.array(z.string()),
	endpoints: z.record(z.string(), EndpointState),
	inFlight: z.record(z.string(), InFlightCall),
	usage: RunUsage,
	/** Why the run's endpoints were all closed: someone used a token that wasn't good. */
	revoked: z.string().optional(),
})
export type RunState = z.infer<typeof RunState>

/** A run id as a file name: the engine's ids are letters, digits and dashes. */
const RunIdText = z.string().regex(/^[\w-]{1,64}$/)

/** Run states, one file each, with changes to one run made one at a time. */
export interface RunStates {
	readonly load: (runId: string, abortSignal: AbortSignal) => Promise<RunState | undefined>
	/** Changes a run's state. `change` gets it as it is now; what it returns is saved, `undefined` removes it. */
	readonly update: <T>(
		runId: string,
		change: (state: RunState | undefined) => { readonly state: RunState | undefined; readonly value: T },
		abortSignal: AbortSignal,
	) => Promise<T>
}

/** The run states in `directory`. */
export function openRunStates(directory: string): RunStates {
	const queues = new Map<string, Promise<unknown>>()
	const fileOf = (runId: string) => path.join(directory, `${RunIdText.parse(runId)}.json`)
	const load = async (runId: string, abortSignal: AbortSignal): Promise<RunState | undefined> => {
		const text = await readTextIfExists(fileOf(runId), abortSignal)
		return text === undefined ? undefined : RunState.parse(JSON.parse(text))
	}
	return Object.freeze<RunStates>({
		load,
		update(runId, change, abortSignal) {
			const previous = queues.get(runId) ?? Promise.resolve()
			const next = previous.then(async () => {
				const { state, value } = change(await load(runId, abortSignal))
				if (state === undefined) await rm(fileOf(runId), { force: true })
				else {
					await mkdir(directory, { recursive: true, mode: 0o700 })
					await writeFileAtomic(fileOf(runId), `${JSON.stringify(state)}\n`, { mode: 0o600 })
				}
				return value
			})
			// The queue only orders the changes; a failed one is its caller's to see.
			const settled = next.then(
				() => undefined,
				() => undefined,
			)
			void settled.then(() => {
				if (queues.get(runId) === settled) queues.delete(runId)
			})
			queues.set(runId, settled)
			return next
		},
	})
}
