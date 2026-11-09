import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Models } from '@earendil-works/pi-ai'
import { openAgentHarness, type AgentHarness } from '../loop/agent-harness.mts'
import { describeError } from '../run/describe-error.mts'
import type { RunChannel } from '../run/run-channel.mts'
import { emitEvent, inEventOf } from '../run/run-events.mts'
import type { RunContext, Scope } from '../run/run-scope.mts'
import { settledWithin } from '../run/settled-within.mts'
import { untilAborted } from '../run/until-aborted.mts'
import type { Workflow } from './workflow.mts'

export interface RunOptions {
	/** Where events and requests go and answers come from. Under the engine: the sandbox's mailbox. */
	readonly channel: RunChannel
	/** Stops the run. Everything in it gets this signal; the run settles promptly once it aborts. */
	readonly abortSignal: AbortSignal
	/** The model providers the run's agents use. Without them, the first loop fails. */
	readonly models?: Models
	/** The run's workspace directory, made when missing. Default `./workspace`. */
	readonly workspace?: string
	/** A SQLite file for the agents' conversations. Default: in memory. */
	readonly agentStore?: string
	/** The run's id, as the engine gave it. A new random id without one. */
	readonly runId?: string
}

/** How a run ended. */
export type RunOutcome = { readonly status: 'succeeded' } | { readonly status: 'failed'; readonly error: unknown }

/** How long a stopped body and closing the agents' store may take, when some work never stops. */
const closeMs = 2_000

/**
 * Runs a workflow: its body in a run scope, as the root of the event tree, then `succeeded` or
 * `failed` to the channel. Never throws; the outcome says how it went.
 *
 * Under the engine, `workflow()` starts this by itself. Call it directly to run a workflow
 * somewhere else, such as in a test with a channel of your own.
 */
export async function runWorkflow(definition: Workflow, options: RunOptions): Promise<RunOutcome> {
	const workspace = path.resolve(options.workspace ?? 'workspace')
	const counts = new Map<string, number>()
	let agents: Promise<AgentHarness> | undefined
	const run: RunContext = {
		runId: options.runId ?? randomUUID(),
		attempt: randomUUID().slice(0, 8),
		workflow: definition.name,
		channel: options.channel,
		abortSignal: options.abortSignal,
		workspace,
		count: (name) => {
			const next = (counts.get(name) ?? 0) + 1
			counts.set(name, next)
			return next
		},
		agents: () => {
			const { models } = options
			if (models === undefined) {
				return Promise.reject(
					new Error(
						'This run has no model providers, so its agents have nothing to run on. They come from the gateway, or from RunOptions.models.',
					),
				)
			}
			agents ??= openAgentHarness(
				{
					models,
					workspace,
					store: options.agentStore,
					onReport: (report) => {
						emitEvent(root, 'agent-report', { kind: report.kind, error: describeError(report.error) })
					},
				},
				options.abortSignal,
			)
			return agents
		},
	}
	const root: Scope = { run, names: [] }

	let outcome: RunOutcome
	try {
		await mkdir(workspace, { recursive: true })
		await inEventOf(root, 'workflow', { workflow: definition.name, runId: run.runId }, () => settle(definition.body(), options.abortSignal))
		outcome = { status: 'succeeded' }
	} catch (error) {
		outcome = { status: 'failed', error }
	}
	// The agents' store is flushed before the engine hears the run is over, and may remove the sandbox.
	if (agents !== undefined) await (await agents.catch(() => undefined))?.close(closeMs)
	options.channel.send(outcome.status === 'succeeded' ? { type: 'succeeded' } : { type: 'failed', error: describeError(outcome.error) })
	return outcome
}

/**
 * Waits for the body, or stops waiting when the run is stopped. A stopped body gets a moment to
 * settle, so the events of the work it was doing land before the workflow's own.
 */
async function settle(body: Promise<void>, abortSignal: AbortSignal): Promise<void> {
	try {
		await untilAborted(body, abortSignal)
	} catch (error) {
		await settledWithin(body, closeMs)
		throw error
	}
}
