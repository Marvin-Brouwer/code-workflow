import type { Models } from '@earendil-works/pi-ai'
import { runWorkflow, type RunOutcome } from '../../src/workflow/run-workflow.mts'
import { workflow } from '../../src/workflow/workflow.mts'
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

/** Runs `body` as a workflow, in a fresh workspace, on a memory channel. */
export async function runBody(body: () => Promise<unknown>, options: { models?: Models } = {}): Promise<BodyRun> {
	const channel = memoryChannel()
	const workspace = await temporaryDirectory()
	const controller = new AbortController()
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
	})
	outcome
		.then((ended) => {
			if (ended.status === 'failed') reject(ended.error)
		})
		.catch(() => undefined)
	return { channel, workspace, controller, outcome, result }
}
