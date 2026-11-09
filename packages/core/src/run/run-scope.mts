import { AsyncLocalStorage } from 'node:async_hooks'
import type { Endpoint, GatewayClient } from '../gateway/gateway-client.mts'
import type { AgentHarness } from '../loop/agent-harness.mts'
import type { LoopClock } from '../loop/loop-clock.mts'
import type { RunChannel } from './run-channel.mts'

/** What every primitive in one run shares. */
export interface RunContext {
	readonly runId: string
	/** Tells this attempt of the run apart from earlier ones, for ids that must not repeat across a restart. */
	readonly attempt: string
	readonly workflow: string
	readonly channel: RunChannel
	/** Aborted when the run is stopped. Primitives pass it on to everything they wait for. */
	readonly abortSignal: AbortSignal
	/** The run's workspace directory, absolute. */
	readonly workspace: string
	/** Counts per name within the run attempt: 1, 2, 3, ... */
	count(name: string): number
	/** The run's agent harness, opened by the first loop. */
	agents(): Promise<AgentHarness>
	/** The run's side of the gateway, for host tools and model calls. Absent outside the engine, unless a test gives one. */
	readonly gateway: GatewayClient | undefined
}

/**
 * Where in a run the current code is: the event node new events go under, the names of the nodes
 * around it, and the loop it runs in, if any. Carried by `AsyncLocalStorage`, so workflow code never
 * passes it around.
 */
export interface Scope {
	readonly run: RunContext
	/** The event that new events are children of. Absent for the run's root event. */
	readonly eventId?: string
	/** Names of the nodes around this code, outermost first, such as `inDependencyOrder` node ids. */
	readonly names: readonly string[]
	/**
	 * The loops this code runs in, outermost first, when it's a tool call of an agent, and the
	 * innermost loop's gateway endpoint when its template has host tools.
	 */
	readonly loop?: { readonly clocks: readonly LoopClock[]; readonly endpoint?: Endpoint }
}

const storage = new AsyncLocalStorage<Scope>()

/** The current scope, or `undefined` outside a run. */
export function findScope(): Scope | undefined {
	return storage.getStore()
}

/** The current scope. Throws outside a run, naming what was called. */
export function currentScope(what: string): Scope {
	const scope = storage.getStore()
	if (scope === undefined) throw new Error(`${what} only works inside a workflow run.`)
	return scope
}

/** Runs `body` in `scope`. */
export function inScope<T>(scope: Scope, body: () => T): T {
	return storage.run(scope, body)
}
