import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Models } from '@earendil-works/pi-ai'
import { z } from 'zod'
import type { GatewayClient } from '../gateway/gateway-client.mts'
import { gatewayModels } from '../gateway/gateway-models.mts'
import { openAgentHarness, type AgentHarness } from '../loop/agent-harness.mts'
import { givenModels, type ModelSource } from '../loop/model-source.mts'
import { describeError } from '../run/describe-error.mts'
import type { RunChannel } from '../run/run-channel.mts'
import { emitEvent, inEventOf } from '../run/run-events.mts'
import type { RunContext, Scope } from '../run/run-scope.mts'
import { settledWithin } from '../run/settled-within.mts'
import { untilAborted } from '../run/until-aborted.mts'
import type { AnyWorkflow, Workflow } from './workflow.mts'

export interface RunOptions<Parameters = unknown> {
	/**
	 * The run's parameters: the input side of the workflow's, checked against them before the body
	 * starts. A run whose parameters don't fit fails. Default `{}`.
	 */
	readonly parameters?: Parameters
	/** Where events and requests go and answers come from. Under the engine: the sandbox's mailbox. */
	readonly channel: RunChannel
	/** Stops the run. Everything in it gets this signal; the run settles promptly once it aborts. */
	readonly abortSignal: AbortSignal
	/**
	 * The model providers the run's agents use, given directly, as in a test. Without them, the
	 * agents' models come through the gateway; without either, the first loop fails.
	 */
	readonly models?: Models
	/** The run's side of the gateway, for host tools and model calls. Under the engine, the entry file makes it. */
	readonly gateway?: GatewayClient
	/**
	 * The run's workspace directory, made when missing. Default `./workspace`. Prompts render its
	 * absolute path, so a rerun with a kept `agentStore` only finds its loops from the same workspace.
	 */
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
 * Under the engine, the entry file (`defineMeshFlow`) starts this with the workflow the engine
 * asked for. Call it directly to run a workflow somewhere else, such as in a test with a channel
 * of your own.
 */
export function runWorkflow<Shape extends z.ZodRawShape>(
	definition: Workflow<Shape>,
	options: RunOptions<z.input<z.ZodObject<Shape>>>,
): Promise<RunOutcome> {
	return runAnyWorkflow(definition, options)
}

/**
 * `runWorkflow` for a workflow and parameters whose types aren't known, such as those the engine's
 * start file names. The parameters are checked against the workflow's all the same.
 */
export async function runAnyWorkflow(definition: AnyWorkflow, options: RunOptions): Promise<RunOutcome> {
	const workspace = path.resolve(options.workspace ?? 'workspace')
	const counts = new Map<string, number>()
	let agents: Promise<AgentHarness> | undefined
	const models = modelSourceOf(options)
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
		gateway: options.gateway,
		agents: () => {
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
		await inEventOf(root, 'workflow', { workflow: definition.name, runId: run.runId }, async () => {
			const parameters = await parametersOf(definition, options.parameters ?? {}, options.abortSignal)
			await settle(definition.body({ parameters, abortSignal: options.abortSignal }), options.abortSignal)
		})
		outcome = { status: 'succeeded' }
	} catch (error) {
		outcome = { status: 'failed', error }
	}
	// The agents' store is flushed before the engine hears the run is over, and may remove the sandbox.
	if (agents !== undefined) await (await agents.catch(() => undefined))?.close(closeMs)
	options.channel.send(outcome.status === 'succeeded' ? { type: 'succeeded' } : { type: 'failed', error: describeError(outcome.error) })
	return outcome
}

/** Where the run's agents get their models: given ones first, otherwise the gateway's. */
function modelSourceOf(options: RunOptions): ModelSource | undefined {
	if (options.models !== undefined) return givenModels(options.models)
	if (options.gateway !== undefined) return gatewayModels(options.gateway)
	return undefined
}

/** The run's parameters, checked against the workflow's. Throws, naming what doesn't fit. */
async function parametersOf(definition: AnyWorkflow, given: unknown, abortSignal: AbortSignal): Promise<Record<string, unknown>> {
	const parsed = await untilAborted(definition.parameters.safeParseAsync(given), abortSignal)
	if (parsed.success) return parsed.data
	throw new Error(`The parameters don't fit workflow ${definition.name}:\n${z.prettifyError(parsed.error)}`)
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
