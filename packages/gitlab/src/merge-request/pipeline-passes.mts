import { branchHeadOf, untilCompleted } from '@mesh-flow/code-repository'
import { check, type Check } from '@mesh-flow/core'
import type { Duration } from '@mesh-flow/duration'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { MergeRequestRef } from '../tools/merge-request-tools.mts'

/** Options of `pipelinePasses`. */
export interface PipelinePassesOptions {
	/** How long to wait between looks while the pipeline runs. Default: 10 seconds. */
	readonly every?: Duration
	/**
	 * How long to wait for a pipeline to appear on a fresh commit before taking a project without CI
	 * for one whose pipeline passed. Default: 10 minutes.
	 */
	readonly appearWithin?: Duration
	/**
	 * How long looks at GitLab may keep failing, say while the network is down, before the check
	 * fails with the last error: once failed looks in a row, `every` apart, have covered
	 * `toleratedOutage`. Default: 10 minutes.
	 */
	readonly toleratedOutage?: Duration
	/**
	 * The checkout whose branch the merge request is of. With it, the commit looked at is the one last
	 * pushed from it, rather than the head GitLab shows, which can lag a few seconds behind a push: a
	 * check right after a push then waits for that commit's pipeline instead of reporting the last one's.
	 */
	readonly checkout?: Repository
}

/**
 * A check for `verify`: waits for the pipeline of the merge request's head commit to complete, and
 * reports each job that failed as a finding, with GitLab's reason and a link to its log. A pipeline
 * takes a while to appear after a push, so a commit without one is looked at again until
 * `appearWithin` has passed; a project without CI then passes. A look that fails is tried again on
 * the next one, for up to `toleratedOutage`. The waits are on the engine's clock, where the run can
 * be paused.
 *
 * @param on - The merge request: anything with its `repository` and `number`.
 * @param options - How often to look, how long to wait for a pipeline to appear and for GitLab to
 * answer again, and the checkout whose last push to look at.
 * @returns The check, for `verify` in an agent's template, or for `runCheck` in code. No findings
 * means the pipeline passed, or that no pipeline appeared within `appearWithin`.
 * @throws From the check: when looks at GitLab kept failing for longer than `toleratedOutage`, or
 * GitLab turns the token down; and, with the stop's reason, when the run stops.
 *
 * @example From code
 * ```ts
 * const findings = await runCheck(gitlab.pipelinePasses(mergeRequest, { checkout: repository }), { abortSignal })
 * const list = findings.map((finding) => `- ${finding.message}`).join('\n')
 * if (findings.length > 0) await jira.comment(story, `The pipeline failed:\n\n${list}`)
 * ```
 *
 * @example For an agent
 * ```ts
 * await developer.loop`
 * 	Fix the build, push with ${gitlab.push(repository)}
 * 	and hand in with ${verify(gitlab.pipelinePasses(mergeRequest, { checkout: repository }))}.
 * `
 * ```
 */
export function pipelinePasses(on: MergeRequestRef, options: PipelinePassesOptions = {}): Check {
	return check('pipeline', async (context) => {
		const where = { repository: on.repository, number: on.number }
		const failures = await untilCompleted(async () => {
			const sha =
				options.checkout === undefined
					? (await stubs.getMergeRequest(where, context)).head.sha
					: await branchHeadOf(options.checkout, true, context)
			return stubs.pipelineOnCommit({ repository: on.repository, sha, mergeRequest: on.number }, context)
		}, options)
		return failures.map((failure) => ({
			source: `pipeline: ${failure.stage}/${failure.name}`,
			message: failure.url === undefined ? failure.summary : `${failure.summary} (${failure.url})`,
		}))
	})
}
