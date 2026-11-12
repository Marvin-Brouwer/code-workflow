import type { WebhookSignature } from '@mesh-flow/core'
import { z } from 'zod'

/** How GitLab signs a delivery: the webhook's secret token itself, in `x-gitlab-token`. */
export const signature: WebhookSignature = Object.freeze({ scheme: 'secret-header', header: 'x-gitlab-token' })

/** The header GitLab names each delivery in, so a redelivery reuses its run. */
export const deliveryHeader = 'x-gitlab-event-uuid'

/** The options every GitLab webhook trigger gets. */
export const triggerOptions = Object.freeze({ signature, deliveryHeader })

const Project = z.object({ id: z.int(), path_with_namespace: z.string(), web_url: z.url() })
const User = z.object({ username: z.string() })
const MergeRequest = z.object({
	iid: z.int().positive(),
	title: z.string(),
	url: z.url(),
	source_branch: z.string(),
	target_branch: z.string(),
	state: z.string(),
})

/**
 * The `merge_request` event. With `action`, only that action fits, such as `open` or `merge`: the
 * filter is in the structure, so the engine turns other deliveries down before it makes a sandbox.
 */
export function mergeRequestEvent(action?: 'open' | 'reopen' | 'update' | 'approved' | 'unapproved' | 'merge' | 'close') {
	return z.object({
		object_kind: z.literal('merge_request'),
		user: User,
		project: Project,
		object_attributes: MergeRequest.extend({ action: action === undefined ? z.string() : z.literal(action) }),
	})
}
export type MergeRequestEvent = z.infer<ReturnType<typeof mergeRequestEvent>>

/** The `note` event for a comment on a merge request, on a line or on the merge request itself. */
export const mergeRequestNote = z.object({
	object_kind: z.literal('note'),
	user: User,
	project: Project,
	object_attributes: z.object({
		id: z.int(),
		note: z.string(),
		noteable_type: z.literal('MergeRequest'),
		url: z.url(),
		discussion_id: z.string().optional(),
	}),
	merge_request: MergeRequest.omit({ url: true, state: true }).extend({ url: z.url().optional() }),
})
export type MergeRequestNote = z.infer<typeof mergeRequestNote>

/** The `pipeline` event. With `status`, only pipelines that ended so fit, such as `failed`. */
export function pipelineEvent(status?: 'success' | 'failed' | 'canceled') {
	return z.object({
		object_kind: z.literal('pipeline'),
		project: Project,
		object_attributes: z.object({
			id: z.int(),
			ref: z.string(),
			sha: z.string(),
			status: status === undefined ? z.string() : z.literal(status),
		}),
		merge_request: z.object({ iid: z.int().positive(), url: z.url() }).nullable().optional(),
	})
}
export type PipelineEvent = z.infer<ReturnType<typeof pipelineEvent>>
