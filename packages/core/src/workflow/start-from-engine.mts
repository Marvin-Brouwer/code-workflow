import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { EndpointGrant, runIdEnvironmentVariable, RunStart, RuntimeMailbox } from '@mesh-flow/protocol'
import { z } from 'zod'
import type { MeshFlowApp } from '../app/define-mesh-flow.mts'
import { describeApp } from '../app/describe-app.mts'
import { gatewayClient, type GatewayClient } from '../gateway/gateway-client.mts'
import { describeError } from '../run/describe-error.mts'
import { untilAborted } from '../run/until-aborted.mts'
import type { ScheduleTrigger, WebhookTrigger } from '../triggers/trigger.mts'
import { runAnyWorkflow } from './run-workflow.mts'
import type { AnyWorkflow } from './workflow.mts'
import { definedWorkflows } from './workflow-registry.mts'

/** What a run starts: a workflow and its parameters, or nothing, because the delivery isn't for it. */
type Begun = { readonly workflow: AnyWorkflow; readonly parameters: unknown } | { readonly skipped: string }

/**
 * Does what the engine started the entry file to do, as its mailbox's start file says: describe
 * what the entry file declares, or run one workflow on the mailbox, with the run id the engine gave
 * it, the workspace and agent store in the home directory, stopped by `SIGTERM` or `SIGINT`. Sets
 * the exit code from the outcome, and exits right away once stopped or once it has described itself.
 *
 * Host tools and the agents' models go through the gateway, on the endpoint the engine handed over
 * in the mailbox.
 */
export async function startFromEngine(app: MeshFlowApp, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const channel = RuntimeMailbox.fromEnvironment(environment)
	const controller = new AbortController()
	const stop = (signal: NodeJS.Signals) => {
		controller.abort(new Error(`The run was stopped (${signal}).`))
	}
	process.once('SIGTERM', stop)
	process.once('SIGINT', stop)
	let describing = false
	try {
		const request = RunStart.parse(await channel.readStart(controller.signal))
		describing = request.mode === 'describe'
		process.exitCode = await dispatch(app, request, channel, environment, controller.signal)
	} catch (error) {
		channel.send({ type: 'failed', error: describeError(error) })
		process.exitCode = 1
	} finally {
		process.off('SIGTERM', stop)
		process.off('SIGINT', stop)
	}
	// Once stopped, what the workflow left behind (a schema that never settles, a timer) must not
	// keep the sandbox running: the outcome is already in the outbox. A module that opens a handle
	// when it's imported mustn't keep a build waiting on a description it already has either.
	if (controller.signal.aborted || describing) process.exit()
}

/** Does what the start file asks for and returns the exit code. */
async function dispatch(
	app: MeshFlowApp,
	request: RunStart,
	channel: RuntimeMailbox,
	environment: NodeJS.ProcessEnv,
	abortSignal: AbortSignal,
): Promise<number> {
	if (request.mode === 'describe') {
		channel.send({ type: 'described', description: describeApp(app) })
		return 0
	}
	const begun = await begin(app, request, abortSignal)
	if ('skipped' in begun) {
		channel.send({ type: 'skipped', reason: begun.skipped })
		return 0
	}
	const runId = environment[runIdEnvironmentVariable]
	const gateway = await gatewayOf(channel, runId, abortSignal)
	const outcome = await runAnyWorkflow(begun.workflow, {
		parameters: begun.parameters,
		channel,
		abortSignal,
		...(gateway === undefined ? {} : { gateway }),
		workspace: path.join(homedir(), 'workspace'),
		agentStore: path.join(homedir(), '.mesh-flow', 'agents.sqlite'),
		...(runId === undefined ? {} : { runId }),
	})
	return outcome.status === 'succeeded' ? 0 : 1
}

/**
 * The workflow to run and its parameters. A webhook delivery goes through its trigger's schema
 * first, which may turn it down. A schedule's parameters are the ones in the entry file, unless the
 * run was fired by hand with parameters of its own.
 */
async function begin(app: MeshFlowApp, request: Extract<RunStart, { mode: 'run' }>, abortSignal: AbortSignal): Promise<Begun> {
	const { trigger: ref } = request
	if (ref === undefined || ref.kind === 'user') return { workflow: workflowNamed(request.workflow), parameters: request.input }
	const trigger = app.triggers.find(
		(candidate): candidate is ScheduleTrigger | WebhookTrigger => candidate.kind === ref.kind && candidate.id === ref.id,
	)
	if (trigger === undefined) throw new Error(`The app has no ${ref.kind} trigger ${ref.id} any more.`)
	if (trigger.workflow.name !== request.workflow)
		throw new Error(`The ${ref.kind} trigger ${ref.id} starts ${trigger.workflow.name}, not ${request.workflow}.`)
	if (trigger.kind === 'schedule') return { workflow: trigger.workflow, parameters: request.input ?? trigger.parameters }
	// A `.refine` or `.transform` can wait on anything; a stop doesn't wait for it.
	const parsed = await untilAborted(trigger.schema.safeParseAsync(request.input), abortSignal)
	if (!parsed.success) return { skipped: `The delivery isn't for ${trigger.workflow.name}:\n${z.prettifyError(parsed.error)}` }
	return { workflow: trigger.workflow, parameters: parsed.data }
}

/** The gateway client for the endpoint the engine handed over, if it has a gateway. Calls are named after the run, so they don't repeat across attempts. */
async function gatewayOf(channel: RuntimeMailbox, runId: string | undefined, abortSignal: AbortSignal): Promise<GatewayClient | undefined> {
	const grant = await channel.takeGateway(abortSignal)
	if (grant === undefined) return undefined
	return gatewayClient(channel, EndpointGrant.parse(grant), randomUUID().slice(0, 8), abortSignal)
}

/** The workflow called `name` among those the entry file's modules define. */
function workflowNamed(name: string): AnyWorkflow {
	const defined = definedWorkflows()
	const found = defined.find((definition) => definition.name === name)
	if (found !== undefined) return found
	const known = defined.map((definition) => definition.name).join(', ') || 'none'
	throw new Error(`There is no workflow ${name}. The entry file's modules define: ${known}.`)
}
