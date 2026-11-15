import { webhook, type WebhookSignature, type WebhookTrigger, type Workflow } from '@mesh-flow/core'
import { z } from 'zod'
import { IssueKey } from './tools/issue-key.mts'

/** How Jira signs a delivery to a webhook with a secret: the hex HMAC-SHA256 of the body in `x-hub-signature`, after `sha256=`. */
export const signature: WebhookSignature = Object.freeze({ scheme: 'hmac-sha256', header: 'x-hub-signature', prefix: 'sha256=' })

/** The header Jira names each delivery in, so a redelivery reuses its run. */
export const deliveryHeader = 'x-atlassian-webhook-identifier'

/**
 * The options every Jira webhook trigger gets: how Jira signs a delivery, and the header that names
 * it. Spread them into a `webhook` trigger of your own on one of the events here.
 *
 * @example
 * ```ts
 * import { jira } from '@mesh-flow/atlassian/hooks'
 * import { webhook } from '@mesh-flow/core'
 * import { triage } from './workflows/triage.mts'
 *
 * export const onCreated = webhook(triage, jira.issueCreated.transform((event) => ({ key: event.issue.key })), {
 * 	name: 'triage-new',
 * 	...jira.triggerOptions,
 * })
 * ```
 */
export const triggerOptions = Object.freeze({ signature, deliveryHeader })

const User = z.object({ displayName: z.string() })
const Issue = z.object({
	key: IssueKey,
	fields: z.object({ summary: z.string(), labels: z.array(z.string()).optional() }),
})

/** One change in a delivery's changelog: the field, and its value before and after as text. */
const ChangeItem = z.object({ field: z.string(), fromString: z.string().nullable(), toString: z.string().nullable() })

/**
 * The `jira:issue_created` event: the issue's key, summary and labels, and who made it. Use it as the
 * schema of a `webhook` trigger, with {@link triggerOptions}, and `transform` it into the
 * workflow's parameters, as the example there shows.
 */
export const issueCreated = z.object({ webhookEvent: z.literal('jira:issue_created'), issue: Issue, user: User })
export type IssueCreated = z.infer<typeof issueCreated>

/**
 * The `jira:issue_updated` event, with what changed. An update that changed no field, such as one
 * Jira sends for a new comment or worklog, comes without a changelog, and reads as one with no items.
 * A `refine` on the changelog keeps a trigger to the updates it cares about; the others end as
 * skipped runs, each of which still starts a sandbox, so narrow the webhook in Jira with JQL too.
 *
 * @example A trigger on a move to a status
 * ```ts
 * const movedToReview = jira.issueUpdated
 * 	.refine((event) => event.changelog.items.some((item) => item.field === 'status' && item.toString === 'In Review'))
 * 	.transform((event) => ({ key: event.issue.key }))
 * webhook(review, movedToReview, { name: 'review-on-status', ...jira.triggerOptions })
 * ```
 */
export const issueUpdated = z.object({
	webhookEvent: z.literal('jira:issue_updated'),
	issue: Issue,
	user: User,
	changelog: z.object({ items: z.array(ChangeItem) }).default({ items: [] }),
})
export type IssueUpdated = z.infer<typeof issueUpdated>

/**
 * The `comment_created` event: the issue, and the comment's id and author.
 *
 * @example
 * ```ts
 * webhook(answer, jira.commentCreated.transform((event) => ({ key: event.issue.key })), {
 * 	name: 'answer-on-comment',
 * 	...jira.triggerOptions,
 * })
 * ```
 */
export const commentCreated = z.object({
	webhookEvent: z.literal('comment_created'),
	issue: Issue,
	comment: z.object({ id: z.string(), author: User }),
})
export type CommentCreated = z.infer<typeof commentCreated>

/** Jira's labels as a changelog writes them: separated by spaces. */
function labelsIn(text: string | null): string[] {
	return (text ?? '').split(' ').filter((label) => label !== '')
}

/**
 * Whether a delivery's changelog puts `label` on the issue: it's among the labels after the update,
 * and wasn't before. What `jira.onIssueLabeled` filters on, for a trigger of your own.
 *
 * @param event - A `jira:issue_updated` delivery, as {@link issueUpdated} parses it.
 * @param label - The label, as Jira writes it.
 * @returns Whether this update added the label.
 *
 * @example
 * ```ts
 * const labeledUrgent = jira.issueUpdated
 * 	.refine((event) => jira.addsLabel(event, 'urgent'))
 * 	.transform((event) => ({ key: event.issue.key }))
 * ```
 */
export function addsLabel(event: IssueUpdated, label: string): boolean {
	return event.changelog.items.some(
		(item) => item.field === 'labels' && labelsIn(item.toString).includes(label) && !labelsIn(item.fromString).includes(label),
	)
}

/** A workflow that takes `JiraIssueParameters`, or `{ key }` with anything else optional. */
export type TakesJiraIssue<Shape extends z.ZodRawShape> =
	{ readonly key: z.input<typeof IssueKey> } extends z.input<z.ZodObject<Shape>> ? Workflow<Shape> : never

/** A label as it fits in a webhook's name. Jira's own labels may hold more, but not spaces. */
const LabelName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes.')

/**
 * Starts `workflow` with `{ key }` whenever `label` is put on an issue: a ready-made `webhook`
 * trigger for the most common way to hand a story to a run.
 *
 * Point a Jira webhook for updated issues at `/webhooks/<app>/<workflow>-labeled-<label>` on the
 * engine: deliveries are checked as Jira signs them, and keyed by Jira's delivery id, so a
 * redelivery reuses its run. Other updates end as skipped runs, since a changelog can't be filtered
 * by structure alone, so narrow the webhook in Jira with JQL, such as `labels = ai-develop`. Give
 * the webhook a secret in Jira, and the same one to the engine, with
 * `mesh-flow webhook secret <app> <workflow>-labeled-<label>`.
 *
 * @param workflow - A workflow whose parameters are `JiraIssueParameters`, or `{ key }` with
 * anything else optional. Any other workflow is a type error.
 * @param label - The label, in lowercase letters, digits and dashes, such as `ai-develop`.
 * @returns The trigger, for the `workflows` of `defineMeshFlow`.
 * @throws When `label` holds anything but lowercase letters, digits and dashes.
 *
 * @example
 * ```ts
 * import { jira } from '@mesh-flow/atlassian/hooks'
 * import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
 * import { develop } from './workflows/develop.mts'
 *
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:26-bookworm' }),
 * 	workflows: [userTrigger(develop), jira.onIssueLabeled(develop, 'ai-develop')],
 * })
 * ```
 */
export function onIssueLabeled<Shape extends z.ZodRawShape>(workflow: TakesJiraIssue<Shape>, label: string): WebhookTrigger {
	const checked = LabelName.parse(label)
	const schema = issueUpdated.refine((event) => addsLabel(event, checked)).transform((event) => ({ key: event.issue.key }))
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TakesJiraIssue has checked that { key } is enough to start it
	const takingKey = workflow as unknown as Workflow<{ key: typeof IssueKey }>
	return webhook(takingKey, schema, { name: `${workflow.name}-labeled-${checked}`, ...triggerOptions })
}
