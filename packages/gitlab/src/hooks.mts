import { NotByConnector } from '@mesh-flow/code-repository'
import type { WebhookSignature } from '@mesh-flow/core'
import { z } from 'zod'

/** How GitLab signs a delivery: the webhook's secret token itself, in `x-gitlab-token`. */
export const signature: WebhookSignature = Object.freeze({ scheme: 'secret-header', header: 'x-gitlab-token' })

/**
 * The header GitLab names each delivery in, the same on its retries and on a resend by hand, so a
 * redelivery reuses its run. GitLab sends it since 17.4; without it, the engine tells deliveries
 * apart by a hash of the body.
 */
export const deliveryHeader = 'idempotency-key'

/**
 * The options every GitLab webhook trigger gets: how GitLab signs a delivery, and the header that
 * names it. Spread them into a `webhook` trigger on one of the events here. Set the webhook's secret
 * with `mesh-flow webhook secret <webhook> --generate` and paste it into GitLab as the
 * webhook's secret token.
 *
 * @example
 * ```ts
 * import { webhook } from '@mesh-flow/core'
 * import { gitlab } from '@mesh-flow/gitlab/hooks'
 * import { release } from './workflows/release.mts'
 *
 * const merged = gitlab.mergeRequestEvent('merge').transform((event) => ({ repository: event.project.path_with_namespace }))
 * export const onMerge = webhook(release, merged, { name: 'release-on-merge', ...gitlab.triggerOptions })
 * ```
 */
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
 * filter is in the structure, so the engine skips other deliveries before it makes a sandbox.
 *
 * @param action - The one action to take deliveries of. Default: every action.
 * @returns The schema, for a `webhook` trigger with {@link triggerOptions}.
 *
 * @example
 * ```ts
 * const opened = gitlab.mergeRequestEvent('open').transform((event) => ({
 * 	repository: event.project.path_with_namespace,
 * 	number: event.object_attributes.iid,
 * }))
 * webhook(review, opened, { name: 'review-on-open', ...gitlab.triggerOptions })
 * ```
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

/**
 * The `note` event for a comment on a merge request, on a line or on the merge request itself. A
 * comment on an issue, a commit or a snippet doesn't fit, and neither does a note a connector wrote,
 * such as the run's own replies, so the engine skips them before it makes a sandbox.
 *
 * @example
 * ```ts
 * const noted = gitlab.mergeRequestNote.transform((event) => ({
 * 	repository: event.project.path_with_namespace,
 * 	number: event.merge_request.iid,
 * }))
 * webhook(answer, noted, { name: 'answer-on-note', ...gitlab.triggerOptions })
 * ```
 */
export const mergeRequestNote = z.object({
	object_kind: z.literal('note'),
	user: User,
	project: Project,
	object_attributes: z.object({
		id: z.int(),
		note: NotByConnector,
		noteable_type: z.literal('MergeRequest'),
		url: z.url(),
		discussion_id: z.string().optional(),
	}),
	merge_request: MergeRequest.omit({ url: true, state: true }).extend({ url: z.url().optional() }),
})
export type MergeRequestNote = z.infer<typeof mergeRequestNote>

/**
 * The `pipeline` event. With `status`, only pipelines that ended with that status fit, such as
 * `failed`. Pipelines of the default branch and of tags fit too. A workflow that should only see
 * merge request pipelines extends the schema with a `merge_request` object, as the example shows.
 *
 * @param status - The one status to take deliveries of. Default: every status, also of pipelines
 * that are still running.
 * @returns The schema, for a `webhook` trigger with {@link triggerOptions}.
 *
 * @example
 * ```ts
 * const failed = gitlab
 * 	.pipelineEvent('failed')
 * 	.extend({ merge_request: z.object({ iid: z.int().positive() }) })
 * 	.transform((event) => ({ repository: event.project.path_with_namespace, branch: event.object_attributes.ref }))
 * webhook(fixPipeline, failed, { name: 'fix-failed-pipeline', ...gitlab.triggerOptions })
 * ```
 */
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
