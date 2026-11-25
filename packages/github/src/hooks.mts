import { NotByConnector } from '@mesh-flow/code-repository'
import { webhook, type WebhookSignature, type WebhookTrigger, type Workflow } from '@mesh-flow/core'
import { z } from 'zod'
import { pinnedRepository } from './pinned-repository.mts'
import { anyCasePattern, RepositoryName } from './repository-name.mts'
import type { IssueReference } from './tools/issue-tools.mts'

/** How GitHub signs a delivery: the hex HMAC-SHA256 of the body in `x-hub-signature-256`, after `sha256=`. */
export const signature: WebhookSignature = Object.freeze({ scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' })

/** The header GitHub names each delivery in, so a redelivery reuses its run. */
export const deliveryHeader = 'x-github-delivery'

/**
 * The options every GitHub webhook trigger gets: how GitHub signs a delivery, and the header that
 * names it. Spread them into a `webhook` trigger on one of the events here. Set the webhook's
 * secret with `mesh-flow webhook secret <webhook> --generate` and paste it into GitHub.
 *
 * @example
 * ```ts
 * import { webhook } from '@mesh-flow/core'
 * import { github } from '@mesh-flow/github/hooks'
 * import { answer } from './workflows/answer.mts'
 *
 * const commented = github.issueCommentCreated.transform((event) => ({
 * 	issue: { repository: event.repository.full_name, number: event.issue.number },
 * 	comment: { body: event.comment.body, url: event.comment.html_url },
 * }))
 * export const onComment = webhook(answer, commented, { name: 'answer-on-comment', ...github.triggerOptions })
 * ```
 */
export const triggerOptions = Object.freeze({ signature, deliveryHeader })

const Repository = z.object({ full_name: z.string() })
const User = z.object({ login: z.string() })
const Issue = z.object({ number: z.int().positive(), title: z.string(), html_url: z.url() })
const PullRequest = z.object({ number: z.int().positive(), title: z.string(), html_url: z.url() })

/** Which `issues` events for a label `issueLabeled` fits. */
export interface IssueLabeledFilter {
	/** The one label to take deliveries of. Default: every label. */
	readonly label?: string | undefined
	/** The one repository, as `owner/name` in any case, to take deliveries of. Default: every repository. */
	readonly repository?: string | undefined
}

/**
 * The `issues` event for a label put on an issue. With a `label` or a `repository`, only that one
 * fits: the filter is in the structure, so the engine skips other deliveries before it makes a
 * sandbox. The repository fits in any case, as GitHub names it. `github.onIssueLabeled` is the
 * ready-made trigger on it.
 *
 * @param filter - Which label and repository fit. Default: every one.
 * @returns The schema, for a `webhook` trigger with {@link triggerOptions}.
 * @throws When `repository` isn't `owner/name`.
 *
 * @example
 * ```ts
 * const labeled = github.issueLabeled({ label: 'needs-triage' }).transform((event) => ({
 * 	issue: { repository: event.repository.full_name, number: event.issue.number },
 * }))
 * webhook(triage, labeled, { name: 'triage-on-label', ...github.triggerOptions })
 * ```
 */
export function issueLabeled({ label, repository }: IssueLabeledFilter = {}) {
	return z.object({
		action: z.literal('labeled'),
		label: z.object({ name: label === undefined ? z.string() : z.literal(label) }),
		issue: Issue,
		repository:
			repository === undefined
				? Repository
				: Repository.extend({ full_name: z.string().regex(anyCasePattern(RepositoryName.parse(repository))) }),
		sender: User,
	})
}
export type IssueLabeled = z.infer<ReturnType<typeof issueLabeled>>

/**
 * The `issue_comment` event for a new comment on an issue or a pull request: GitHub sends both as
 * this event. A comment a connector wrote, such as the run's own replies, doesn't fit, so the
 * engine skips it before it makes a sandbox. `github.collect` writes an issue without its
 * comments, so a workflow that answers the comment takes it from the payload, as below. Comments on
 * closed issues fit too.
 *
 * @example
 * ```ts
 * const commented = github.issueCommentCreated.transform((event) => ({
 * 	issue: { repository: event.repository.full_name, number: event.issue.number },
 * 	comment: { body: event.comment.body, url: event.comment.html_url },
 * }))
 * webhook(answer, commented, { name: 'answer-on-comment', ...github.triggerOptions })
 * ```
 */
export const issueCommentCreated = z.object({
	action: z.literal('created'),
	issue: Issue.extend({ pull_request: z.object({ url: z.url() }).optional() }),
	comment: z.object({ id: z.int(), body: NotByConnector, html_url: z.url(), user: User }),
	repository: Repository,
})
export type IssueCommentCreated = z.infer<typeof issueCommentCreated>

/** What every submitted review has, whatever its state. */
const SubmittedReview = z.object({ id: z.int(), html_url: z.url(), user: User })

/**
 * The `pull_request_review` event for a submitted review. GitHub wraps every reply in a thread of
 * line comments, the run's own too, in a review of its own, `commented` and without a body. Such a
 * review doesn't fit, and neither does a review whose body a connector wrote, so the engine skips
 * them before it makes a sandbox. A person's `commented` review with only line comments looks the
 * same and is skipped as well; `github.review` in a running workflow sees its comments.
 *
 * @example
 * ```ts
 * const reviewed = github.pullRequestReviewSubmitted.transform((event) => ({
 * 	repository: event.repository.full_name,
 * 	number: event.pull_request.number,
 * }))
 * webhook(handleReview, reviewed, { name: 'handle-review', ...github.triggerOptions })
 * ```
 */
export const pullRequestReviewSubmitted = z.object({
	action: z.literal('submitted'),
	review: z.union([
		SubmittedReview.extend({ state: z.enum(['approved', 'changes_requested', 'dismissed']), body: NotByConnector.nullable() }),
		// A reply in a thread comes as a review of its own, `commented` without a body.
		SubmittedReview.extend({ state: z.literal('commented'), body: NotByConnector.min(1) }),
	]),
	pull_request: PullRequest,
	repository: Repository,
})
export type PullRequestReviewSubmitted = z.infer<typeof pullRequestReviewSubmitted>

/**
 * The `pull_request_review_comment` event for a new comment on a line, also a reply in a thread
 * (`in_reply_to_id`). A comment a connector wrote, such as the run's own replies, doesn't fit, so
 * the engine skips it before it makes a sandbox.
 *
 * GitHub sends one delivery per comment, so a review with eight comments starts eight runs at once.
 * A workflow on this event handles the one comment it was started for, from the payload, rather
 * than watching the whole review with `github.review`, which those runs would all do at once.
 *
 * @example
 * ```ts
 * const lineCommented = github.pullRequestReviewCommentCreated.transform((event) => ({
 * 	repository: event.repository.full_name,
 * 	number: event.pull_request.number,
 * 	// The form `github.reply` takes the comment's id in.
 * 	item: `review-comment/${String(event.comment.id)}`,
 * 	comment: { body: event.comment.body, path: event.comment.path },
 * }))
 * webhook(answerLineComment, lineCommented, { name: 'answer-line-comment', ...github.triggerOptions })
 * ```
 */
export const pullRequestReviewCommentCreated = z.object({
	action: z.literal('created'),
	comment: z.object({
		id: z.int(),
		body: NotByConnector,
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

/**
 * A workflow that takes `IssueParameters`, or `{ issue }` with anything else optional, where the
 * issue may be pinned to one repository, as `github.issueIn` makes it. The issue itself can't be
 * optional: an event always gives one.
 */
export type TakesIssue<Shape extends z.ZodRawShape> = Shape extends { readonly issue: infer IssueSchema extends z.ZodType }
	? z.input<IssueSchema> extends z.input<typeof IssueReference>
		? { readonly issue: z.input<IssueSchema> } extends z.input<z.ZodObject<Shape>>
			? Workflow<Shape>
			: never
		: never
	: never

/** The name of a label, as GitHub takes it and as it fits in a webhook's name. */
const LabelName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes.')

/**
 * Starts `workflow` with `{ issue: { repository, number } }` whenever `label` is put on an issue.
 * The webhook is named `<workflow>-labeled-<label>`, signed as GitHub signs, and keyed by GitHub's
 * delivery id. The workflow has to take `IssueParameters`, or `github.issue` as its `issue`
 * parameter. With `github.issueIn('owner/name')` as its `issue`, the repository is pinned: only its
 * events fit, in any case, and other repositories' events are skipped before a sandbox. Only
 * `issueIn` pins it this way; a workflow that narrows the repository otherwise is refused a run at
 * its parameter check instead, after a sandbox is made.
 *
 * Point a GitHub webhook for `Issues` events at `/webhooks/<workflow>-labeled-<label>` on the
 * engine. Set its secret with `mesh-flow webhook secret <workflow>-labeled-<label> --generate`
 * and paste it into GitHub. The engine skips other labels before it makes a sandbox.
 *
 * @param workflow - A workflow whose `issue` is `github.issue` or `github.issueIn('owner/name')`,
 * with anything else optional. Any other workflow is a type error.
 * @param label - The label, in lowercase letters, digits and dashes, such as `ai-fix`.
 * @returns The trigger, for the `workflows` of `defineMeshFlow`.
 * @throws When `label` holds anything but lowercase letters, digits and dashes.
 *
 * @example
 * ```ts
 * import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
 * import { github } from '@mesh-flow/github/hooks'
 * import { fixIssue } from './workflows/issues.mts'
 *
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:26-bookworm' }),
 * 	workflows: [userTrigger(fixIssue), github.onIssueLabeled(fixIssue, 'ai-fix')],
 * })
 * ```
 */
export function onIssueLabeled<Shape extends z.ZodRawShape>(workflow: TakesIssue<Shape>, label: string): WebhookTrigger {
	const checked = LabelName.parse(label)
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TakesIssue has checked that { issue } is enough to start it
	const takingIssue = workflow as unknown as Workflow<{ issue: typeof IssueReference }>
	// A workflow pinned to one repository only fits that repository's events, so the others are skipped before a sandbox.
	const repository = pinnedRepository(takingIssue.parameters.shape.issue)
	const schema = issueLabeled({ label: checked, repository }).transform((event) => ({
		// GitHub may case the name otherwise than the pin, which the workflow's parameters fix exactly.
		issue: { repository: repository ?? event.repository.full_name, number: event.issue.number },
	}))
	return webhook(takingIssue, schema, { name: `${takingIssue.name}-labeled-${checked}`, ...triggerOptions })
}
