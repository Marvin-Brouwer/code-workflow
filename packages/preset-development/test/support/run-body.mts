import type { Models } from '@earendil-works/pi-ai/models'
import { runWorkflow, workflow, type RunChannel, type RunOutcome } from '@mesh-flow/core'
import { onTestFinished } from 'vitest'
import { temporaryDirectory } from './temporary-directory.mts'

/** A run of a test's body. */
export interface BodyRun<Result> {
	readonly workspace: string
	readonly controller: AbortController
	readonly outcome: Promise<RunOutcome>
	/** What the body returned, or why it threw. */
	readonly result: Promise<Result>
}

/** A channel that keeps nothing and answers no request: the preset asks no person anything. */
const silentChannel: RunChannel = {
	send: () => undefined,
	answer: (_requestId, abortSignal) =>
		new Promise((_resolve, reject) => {
			abortSignal.addEventListener('abort', () => {
				reject(abortSignal.reason)
			})
		}),
}

/** Runs `body` as a workflow in a fresh workspace, with `models` for its agents. The run is stopped when the test ends. */
export async function runBody<Result>(body: () => Promise<Result>, models?: Models): Promise<BodyRun<Result>> {
	const workspace = await temporaryDirectory()
	const controller = new AbortController()
	onTestFinished(() => {
		controller.abort(new Error('The test finished.'))
	})
	const { promise: result, resolve, reject } = Promise.withResolvers<Result>()
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
		channel: silentChannel,
		abortSignal: controller.signal,
		workspace,
		...(models === undefined ? {} : { models }),
	})
	return { workspace, controller, outcome, result }
}
