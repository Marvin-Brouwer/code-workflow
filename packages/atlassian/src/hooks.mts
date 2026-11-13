import { webhook, type WebhookSignature, type WebhookTrigger, type Workflow } from '@mesh-flow/core'
import { z } from 'zod'
import { IssueKey } from './tools/issue-key.mts'

/** How Jira signs a delivery to a webhook with a secret: the hex HMAC-SHA256 of the body in `x-hub-signature`, after `sha256=`. */
export const signature: WebhookSignature = Object.freeze({ scheme: 'hmac-sha256', header: 'x-hub-signature', prefix: 'sha256=' })

/** The header Jira names each delivery in, so a redelivery reuses its run. */
export const deliveryHeader = 'x-atlassian-webhook-identifier'

/** The options every Jira webhook trigger gets. */
export const triggerOptions = Object.freeze({ signature, deliveryHeader })

const User = z.object({ displayName: z.string() })
const Issue = z.object({
	key: IssueKey,
	fields: z.object({ summary: z.string(), labels: z.array(z.string()).optional() }),
})

/** One change in a delivery's changelog: the field, and its value before and after as text. */
const ChangeItem = z.object({ field: z.string(), fromString: z.string().nullable(), toString: z.string().nullable() })

/** The `jira:issue_created` event. */
export const issueCreated = z.object({ webhookEvent: z.literal('jira:issue_created'), issue: Issue, user: User })
export type IssueCreated = z.infer<typeof issueCreated>

/**
 * The `jira:issue_updated` event, with what changed. An update that changed no field, such as one
 * Jira sends for a new comment or worklog, comes without a changelog, and reads as one with no items.
 */
export const issueUpdated = z.object({
	webhookEvent: z.literal('jira:issue_updated'),
	issue: Issue,
	user: User,
	changelog: z.object({ items: z.array(ChangeItem) }).default({ items: [] }),
})
export type IssueUpdated = z.infer<typeof issueUpdated>

/** The `comment_created` event. */
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

/** Whether a delivery's changelog puts `label` on the issue. */
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
 * Starts `workflow` with `{ key }` whenever `label` is put on an issue. Point a Jira webhook for
 * updated issues at it; the webhook is named `<workflow>-labeled-<label>`, signed as Jira signs, and
 * keyed by Jira's delivery id. Other updates end as skipped runs, since a changelog can't be
 * filtered by structure alone, so narrow the webhook in Jira with JQL, such as `labels = ai-develop`.
 *
 * ```ts
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:22-bookworm' }),
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
