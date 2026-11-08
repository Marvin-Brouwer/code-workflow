import { homedir } from 'node:os'
import path from 'node:path'
import { runIdEnvironmentVariable, RuntimeMailbox } from '@mesh-flow/protocol'
import { runWorkflow } from './run-workflow.mts'
import type { Workflow } from './workflow.mts'

/**
 * Runs a workflow the way the engine starts it: on the sandbox's mailbox, with the run id the engine
 * gave it, the workspace and agent store in the home directory, and stopped by `SIGTERM` or
 * `SIGINT`. Sets the exit code from the outcome.
 *
 * Model providers come with the gateway; until then a loop in an engine run fails up front.
 */
export async function startFromEngine(workflow: Workflow, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const channel = RuntimeMailbox.fromEnvironment(environment)
	const controller = new AbortController()
	const stop = (signal: NodeJS.Signals) => {
		controller.abort(new Error(`The run was stopped (${signal}).`))
	}
	process.once('SIGTERM', stop)
	process.once('SIGINT', stop)
	const runId = environment[runIdEnvironmentVariable]
	const outcome = await runWorkflow(workflow, {
		channel,
		signal: controller.signal,
		workspace: path.join(homedir(), 'workspace'),
		agentStore: path.join(homedir(), '.mesh-flow', 'agents.sqlite'),
		...(runId === undefined ? {} : { runId }),
	})
	process.off('SIGTERM', stop)
	process.off('SIGINT', stop)
	process.exitCode = outcome.status === 'succeeded' ? 0 : 1
}
