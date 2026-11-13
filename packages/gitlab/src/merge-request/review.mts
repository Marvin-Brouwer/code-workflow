import type { ToolContext, WaitSpec } from '@mesh-flow/core'
import { watchReview } from '@mesh-flow/code-repository'
import { stubs } from '../stubs.mts'
import type { JobFailure, MergeRequestRef, ReviewItem } from '../tools/merge-request-tools.mts'
import { mergeRequestOf, type MergeRequest } from './merge-request.mts'

/** The pipeline of one commit failed. */
export interface PipelineFailed {
	readonly mergeRequest: MergeRequest
	readonly sha: string
	/** The jobs that failed, each with the reason GitLab gives and a link to its log. */
	readonly failures: readonly JobFailure[]
}

/** What `review` calls as a merge request's review goes on. Each handler finishes before the next event is looked at. */
export interface ReviewHandlers {
	/**
	 * New comments, on lines and on the merge request, coalesced per look, oldest first. What the
	 * run posted itself, and GitLab's system notes, are left out. Before the handler is called, each
	 * item gets 👀 on GitLab, and a "👀 Reading..." reply in its thread.
	 */
	readonly comments?: (comments: readonly ReviewItem[]) => Promise<unknown>
	/** The pipeline of the merge request's head commit came out failed. Once per commit. */
	readonly pipelineFailed?: (failed: PipelineFailed) => Promise<unknown>
}

/** Options of `review`. */
export interface ReviewOptions {
	/** How long to wait between looks. Default: 10 seconds. */
	readonly every?: WaitSpec
	/**
	 * How long looks at GitLab may keep failing, say while the network is down, before `review`
	 * gives up with the last error. Counted in looks, `toleratedOutage / every` of them. Only
	 * failures that may pass count; a bad token or a missing permission fails at once. Default: 10 minutes.
	 */
	readonly toleratedOutage?: WaitSpec
}

/** How a review ended. */
export interface ReviewOutcome {
	readonly state: 'merged' | 'closed'
	readonly mergeRequest: MergeRequest
}

/**
 * Watches a merge request until it's merged or closed, and calls the handlers as things happen on
 * it: comments come in one list per look, so a reviewer's round is one call, and a failed pipeline
 * comes once per commit, once it has completed. An item handed to the handler gets 👀 on GitLab
 * first, and a "👀 Reading..." reply in its thread that the first answer to it replaces, taking the
 * 👀 off again. Handlers run one at a time. The wait between looks is on the engine's clock, where
 * the run can be paused. A look that fails is tried again on the next one, for up to
 * `toleratedOutage`, so a watch that takes days outlives a dropped connection.
 *
 * ```ts
 * await gitlab.review(mergeRequest, {
 * 	pipelineFailed: ({ failures }) => developer.loop`
 * 		The pipeline of ${mergeRequest} failed: ${failures}. Fix it in ${repository}, push with
 * 		${gitlab.push(repository)}, and hand in with ${verify(gitlab.pipelinePasses(mergeRequest, { checkout: repository }))}.
 * 	`,
 * 	comments: async (comments) => {
 * 		const changes = await gitlab.triage(developer, repository, { mergeRequest, comments })
 * 		// Make each change, and reply with what was done.
 * 	},
 * })
 * ```
 */
export async function review(
	on: MergeRequestRef,
	handlers: ReviewHandlers,
	options: ReviewOptions = {},
	context?: ToolContext,
): Promise<ReviewOutcome> {
	const where = { repository: on.repository, number: on.number }
	const { pipelineFailed } = handlers
	const { state, request } = await watchReview<MergeRequest, ReviewItem, JobFailure>(
		{
			read: async () => mergeRequestOf(await stubs.getMergeRequest(where, context)),
			activity: (since) => stubs.reviewActivity({ ...where, ...(since === undefined ? {} : { since }) }, context),
			showBeingRead: (items) => stubs.showBeingRead({ ...where, items: items.map((item) => item.id) }, context),
			checks: (sha) => stubs.pipelineOnCommit({ repository: on.repository, sha, mergeRequest: on.number }, context),
		},
		{
			...(handlers.comments === undefined ? {} : { comments: handlers.comments }),
			...(pipelineFailed === undefined ? {} : { failed: (mergeRequest, sha, failures) => pipelineFailed({ mergeRequest, sha, failures }) }),
		},
		options,
	)
	return { state, mergeRequest: request }
}
