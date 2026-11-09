import { homedir } from 'node:os'
import path from 'node:path'
import { runIdEnvironmentVariable, RunStart, RuntimeMailbox } from '@mesh-flow/protocol'
import { z } from 'zod'
import type { WorkflowEntry } from '../triggers/define-workflows.mts'
import { describeEntry } from '../triggers/describe-entry.mts'
import { describeError } from '../run/describe-error.mts'
import { runUnchecked } from './run-workflow.mts'
import type { AnyWorkflow } from './workflow.mts'
import { definedWorkflows } from './workflow-registry.mts'

/** What a run starts: a workflow and its parameters, or nothing, because the delivery isn't for it. */
type Begun = { readonly workflow: AnyWorkflow; readonly parameters: unknown } | { readonly skipped: string }

/**
 * Does what the engine started the entry file to do, as its mailbox's start file says: describe
 * what the entry file declares, or run one workflow on the mailbox, with the run id the engine gave
 * it, the workspace and agent store in the home directory, stopped by `SIGTERM` or `SIGINT`. Sets
 * the exit code from the outcome.
 *
 * Model providers come with the gateway; until then a loop in an engine run fails up front.
 */
export async function startFromEngine(entry: WorkflowEntry, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const channel = RuntimeMailbox.fromEnvironment(environment)
	const controller = new AbortController()
	const stop = (signal: NodeJS.Signals) => {
		controller.abort(new Error(`The run was stopped (${signal}).`))
	}
	process.once('SIGTERM', stop)
	process.once('SIGINT', stop)
	try {
		process.exitCode = await start(entry, channel, environment, controller.signal)
	} catch (error) {
		channel.send({ type: 'failed', error: describeError(error) })
		process.exitCode = 1
	} finally {
		process.off('SIGTERM', stop)
		process.off('SIGINT', stop)
	}
}

/** Runs what the start file asks for and returns the exit code. */
async function start(
	entry: WorkflowEntry,
	channel: RuntimeMailbox,
	environment: NodeJS.ProcessEnv,
	abortSignal: AbortSignal,
): Promise<number> {
	const request = RunStart.parse(await channel.start(abortSignal))
	if (request.mode === 'describe') {
		channel.send({ type: 'described', description: describeEntry(entry) })
		return 0
	}
	const begun = await begin(entry, request, abortSignal)
	if ('skipped' in begun) {
		channel.send({ type: 'skipped', reason: begun.skipped })
		return 0
	}
	const runId = environment[runIdEnvironmentVariable]
	const outcome = await runUnchecked(begun.workflow, {
		parameters: begun.parameters,
		channel,
		abortSignal,
		workspace: path.join(homedir(), 'workspace'),
		agentStore: path.join(homedir(), '.mesh-flow', 'agents.sqlite'),
		...(runId === undefined ? {} : { runId }),
	})
	return outcome.status === 'succeeded' ? 0 : 1
}

/**
 * The workflow to run and its parameters. A webhook delivery goes through its trigger's schema
 * first, which may turn it down; a schedule's parameters are the ones in the entry file.
 */
async function begin(entry: WorkflowEntry, request: Extract<RunStart, { mode: 'run' }>, abortSignal: AbortSignal): Promise<Begun> {
	const { trigger: ref } = request
	if (ref === undefined || ref.kind === 'user') return { workflow: workflowNamed(request.workflow), parameters: request.input }
	const trigger = entry.triggers.find((candidate) => candidate.kind === ref.kind && candidate.id === ref.id)
	if (trigger === undefined) throw new Error(`The entry file has no ${ref.kind} trigger ${ref.id} any more.`)
	if (trigger.workflow.name !== request.workflow)
		throw new Error(`The ${ref.kind} trigger ${ref.id} starts ${trigger.workflow.name}, not ${request.workflow}.`)
	if (trigger.kind === 'schedule') return { workflow: trigger.workflow, parameters: trigger.parameters }
	if (trigger.kind === 'user') return { workflow: trigger.workflow, parameters: request.input }
	abortSignal.throwIfAborted()
	const parsed = await trigger.schema.safeParseAsync(request.input)
	if (!parsed.success) return { skipped: `The delivery isn't for ${trigger.workflow.name}:\n${z.prettifyError(parsed.error)}` }
	return { workflow: trigger.workflow, parameters: parsed.data }
}

/** The workflow called `name` among those the entry file's modules define. */
function workflowNamed(name: string): AnyWorkflow {
	const defined = definedWorkflows()
	const found = defined.find((definition) => definition.name === name)
	if (found !== undefined) return found
	const known = defined.map((definition) => definition.name).join(', ') || 'none'
	throw new Error(`There is no workflow ${name}. The entry file's modules define: ${known}.`)
}
