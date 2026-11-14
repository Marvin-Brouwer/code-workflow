import { webhook, type WebhookSignature, type WebhookTrigger, type Workflow } from '@mesh-flow/core'
import { z } from 'zod'
import type { IssueRef } from './tools/issue-tools.mts'

/** How GitHub signs a delivery: the hex HMAC-SHA256 of the body in `x-hub-signature-256`, after `sha256=`. */
export const signature: WebhookSignature = Object.freeze({ scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' })

/** The header GitHub names each delivery in, so a redelivery reuses its run. */
export const deliveryHeader = 'x-github-delivery'

/** The options every GitHub webhook trigger gets. */
export const triggerOptions = Object.freeze({ signature, deliveryHeader })

const Repository = z.object({ full_name: z.string() })
const User = z.object({ login: z.string() })
const Issue = z.object({ number: z.int().positive(), title: z.string(), html_url: z.url() })
const PullRequest = z.object({ number: z.int().positive(), title: z.string(), html_url: z.url() })

/**
 * The `issues` event for a label put on an issue. With `label`, only that label fits: the filter
 * is in the structure, so the engine turns other deliveries down before it makes a sandbox.
 */
export function issueLabeled(label?: string) {
	return z.object({
		action: z.literal('labeled'),
		label: z.object({ name: label === undefined ? z.string() : z.literal(label) }),
		issue: Issue,
		repository: Repository,
		sender: User,
	})
}
export type IssueLabeled = z.infer<ReturnType<typeof issueLabeled>>

/** The `issue_comment` event for a new comment on an issue or a pull request. */
export const issueCommentCreated = z.object({
	action: z.literal('created'),
	issue: Issue.extend({ pull_request: z.object({ url: z.url() }).optional() }),
	comment: z.object({ id: z.int(), body: z.string(), html_url: z.url(), user: User }),
	repository: Repository,
})
export type IssueCommentCreated = z.infer<typeof issueCommentCreated>

/** The `pull_request_review` event for a submitted review. */
export const pullRequestReviewSubmitted = z.object({
	action: z.literal('submitted'),
	review: z.object({
		id: z.int(),
		body: z.string().nullable(),
		state: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']),
		html_url: z.url(),
		user: User,
	}),
	pull_request: PullRequest,
	repository: Repository,
})
export type PullRequestReviewSubmitted = z.infer<typeof pullRequestReviewSubmitted>

/** The `pull_request_review_comment` event for a new comment on a line. */
export const pullRequestReviewCommentCreated = z.object({
	action: z.literal('created'),
	comment: z.object({
		id: z.int(),
		body: z.string(),
		path: z.string(),
		line: z.int().nullable().optional(),
		html_url: z.url(),
		user: User,
		in_reply_to_id: z.int().optional(),
	}),
	pull_request: PullRequest,
	repository: Repository,
})
export type PullRequestReviewCommentCreated = z.infer<typeof pullRequestReviewCommentCreated>

/** A workflow that takes `IssueParameters`, or `{ issue }` with anything else optional. */
export type TakesIssue<Shape extends z.ZodRawShape> =
	{ readonly issue: z.input<typeof IssueRef> } extends z.input<z.ZodObject<Shape>> ? Workflow<Shape> : never

/** The name of a label, as GitHub takes it and as it fits in a webhook's name. */
const LabelName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes.')

/**
 * Starts `workflow` with `{ issue: { repository, number } }` whenever `label` is put on an issue.
 * The webhook is named `<workflow>-labeled-<label>`, signed as GitHub signs, and keyed by GitHub's
 * delivery id. The workflow has to take `IssueParameters`, or `github.issue` as its `issue` parameter.
 *
 * ```ts
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:26-bookworm' }),
 * 	workflows: [userTrigger(fixIssue), github.onIssueLabeled(fixIssue, 'ai-fix')],
 * })
 * ```
 */
export function onIssueLabeled<Shape extends z.ZodRawShape>(workflow: TakesIssue<Shape>, label: string): WebhookTrigger {
	const checked = LabelName.parse(label)
	const schema = issueLabeled(checked).transform((event) => ({
		issue: { repository: event.repository.full_name, number: event.issue.number },
	}))
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TakesIssue has checked that { issue } is enough to start it
	const takingIssue = workflow as unknown as Workflow<{ issue: typeof IssueRef }>
	return webhook(takingIssue, schema, { name: `${workflow.name}-labeled-${checked}`, ...triggerOptions })
}
