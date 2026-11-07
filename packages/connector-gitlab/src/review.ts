import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { api, type MergeRequest, type ReviewEvent } from './api'

export const Triage = z.object({
	comments: z.array(
		z.object({
			commentId: z.string(),
			kind: z.enum(['question', 'remark', 'both']),
			action: z.enum(['answered', 'changed', 'declined', 'escalated']),
			summary: z.string(),
		}),
	),
})

/**
 * Watches a merge request until it's merged and calls the handlers as events come in.
 * Waits durably on the engine's external-event primitive. Policies: handlers run one at a time
 * per merge request, events for superseded commits are dropped, comments from one review round
 * are coalesced into one call.
 */
export function review(
	mergeRequest: MergeRequest,
	handlers: {
		pipelineFailed?: (failure: Extract<ReviewEvent, { type: 'pipelineFailed' }>) => Promise<unknown>
		taggedComments?: (comments: Extract<ReviewEvent, { type: 'comment' }>[]) => Promise<unknown>
	},
): Promise<void> {
	return api.watch(mergeRequest, { until: 'merged', ...handlers })
}

export function reply(mergeRequest: MergeRequest) {
	return tool('reply', {
		description: 'Reply to a comment on the merge request.',
		input: z.object({ commentId: z.string(), text: z.string() }),
		action: ({ commentId, text }) => api.reply(mergeRequest, commentId, text),
	})
}
