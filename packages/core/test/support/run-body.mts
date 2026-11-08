import type { Models } from '@earendil-works/pi-ai'
import { runWorkflow, type RunOutcome } from '../../src/workflow/run-workflow.mts'
import { workflow } from '../../src/workflow/workflow.mts'
import { onTestFinished } from 'vitest'
import { memoryChannel, type MemoryChannel } from './memory-channel.mts'
import { temporaryDirectory } from './temporary-directory.mts'

export interface BodyRun {
	readonly channel: MemoryChannel
	readonly workspace: string
	readonly controller: AbortController
	/** The run's outcome, once it ended. */
	readonly outcome: Promise<RunOutcome>
	/** What the body returned, or why it threw. */
	readonly result: Promise<unknown>
}

export interface BodyRunOptions {
	readonly models?: Models
	/** The agents' store, for runs that share one. In memory without it. */
	readonly agentStore?: string
	/** The workspace, for runs that share one. A fresh directory without it. */
	readonly workspace?: string
}

/** Runs `body` as a workflow, in a fresh workspace, on a memory channel. The run is stopped when the test ends. */
export async function runBody(body: () => Promise<unknown>, options: BodyRunOptions = {}): Promise<BodyRun> {
	const channel = memoryChannel()
	const workspace = options.workspace ?? (await temporaryDirectory())
	const controller = new AbortController()
	onTestFinished(() => {
		controller.abort(new Error('The test finished.'))
	})
	const { promise: result, resolve, reject } = Promise.withResolvers<unknown>()
	// Observed here, so a test that only looks at the outcome doesn't leave a rejection unhandled.
	result.catch(() => undefined)
	const definition = workflow('test', async () => {
		try {
			resolve(await body())
		} catch (error) {
			reject(error)
			throw error
		}
	})
	const outcome = runWorkflow(definition, {
		channel,
		signal: controller.signal,
		workspace,
		...(options.models === undefined ? {} : { models: options.models }),
		...(options.agentStore === undefined ? {} : { agentStore: options.agentStore }),
	})
	outcome
		.then((ended) => {
			if (ended.status === 'failed') reject(ended.error)
		})
		.catch(() => undefined)
	return { channel, workspace, controller, outcome, result }
}
