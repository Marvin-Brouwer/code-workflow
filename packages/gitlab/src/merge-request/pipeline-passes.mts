import { check, wait, type Check, type WaitSpec } from '@mesh-flow/core'
import { defaultAppearWithin, defaultLookEvery, defaultToleratedOutage, looksWithin, patientLook } from '@mesh-flow/forge'
import { stubs } from '../stubs.mts'
import type { MergeRequestRef } from '../tools/merge-request-tools.mts'

/** Options of `pipelinePasses`. */
export interface PipelinePassesOptions {
	/** How long to wait between looks while the pipeline runs. Default: 10 seconds. */
	readonly every?: WaitSpec
	/**
	 * How long to wait for a pipeline to appear on a fresh commit before taking a project without CI
	 * for one whose pipeline passed. Default: 10 minutes.
	 */
	readonly appearWithin?: WaitSpec
	/**
	 * How long looks at GitLab may keep failing, say while the network is down, before the check
	 * fails with the last error. Counted in looks, as in `review`. Default: 10 minutes.
	 */
	readonly toleratedOutage?: WaitSpec
}

/**
 * A check for `verify`: waits for the pipeline of the merge request's head commit to complete, and
 * reports each job that failed as a finding. A pipeline takes a while to appear after a push, so a
 * commit without one is looked at again until `appearWithin` has passed. A look that fails is tried
 * again on the next one, for up to `toleratedOutage`.
 *
 * ```ts
 * await developer.loop`Fix the build, push with ${gitlab.push(repository)} and hand in with ${verify(gitlab.pipelinePasses(mergeRequest))}.`
 * ```
 */
export function pipelinePasses(on: MergeRequestRef, options: PipelinePassesOptions = {}): Check {
	const every = options.every ?? defaultLookEvery
	const looksForPipelineToAppear = looksWithin(options.appearWithin ?? defaultAppearWithin, every)
	const look = patientLook({ every, toleratedOutage: options.toleratedOutage ?? defaultToleratedOutage })
	return check('pipeline', async (context) => {
		const where = { repository: on.repository, number: on.number }
		let looksWithoutPipeline = 0
		for (;;) {
			const pipeline = await look(async () => {
				const { head } = await stubs.getMergeRequest(where, context)
				return stubs.pipelineOnCommit({ repository: on.repository, sha: head.sha, mergeRequest: on.number }, context)
			})
			if (pipeline.status === 'none') looksWithoutPipeline++
			const done = pipeline.status === 'completed' || (pipeline.status === 'none' && looksWithoutPipeline > looksForPipelineToAppear)
			if (done) {
				return pipeline.failures.map((failure) => ({
					source: `pipeline: ${failure.stage}/${failure.name}`,
					message: failure.url === undefined ? failure.summary : `${failure.summary} (${failure.url})`,
				}))
			}
			await wait(every)
		}
	})
}
