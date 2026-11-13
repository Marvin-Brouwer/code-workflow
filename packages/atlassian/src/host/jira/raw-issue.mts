import { z } from 'zod'

const Named = z.object({ name: z.string() }).nullish()
const Person = z.object({ displayName: z.string() }).nullish()

/** A time Jira gave: Cloud's client hands it over as a `Date`, Data Center's as Jira's text. Text either way. */
const Time = z
	.union([z.string(), z.date()])
	.transform((time) => (typeof time === 'string' ? time : time.toISOString()))
	.default('')

/** Another issue as Jira nests it in a field: a parent, a subtask or the other end of a link. */
const NestedIssue = z.object({
	key: z.string(),
	fields: z.object({ summary: z.string().default(''), status: Named }).default({ summary: '', status: null }),
})
export type NestedIssue = z.infer<typeof NestedIssue>

/** A file attached to an issue: `content` is where its bytes are, on the site. */
export const RawAttachment = z.object({
	id: z.string(),
	filename: z.string(),
	mimeType: z.string().default('application/octet-stream'),
	size: z.number().default(0),
	content: z.string(),
})
export type RawAttachment = z.infer<typeof RawAttachment>

/** A comment as Jira lists it in an issue's `comment` field. */
const RawComment = z.object({ id: z.string(), author: Person, created: Time })

/**
 * The fields of an issue this connector reads, the same on Cloud and Data Center. Loose on purpose:
 * a site's configuration decides which fields an issue has, so a missing one is an empty value.
 */
export const RawIssue = z.object({
	key: z.string(),
	fields: z.object({
		summary: z.string().default(''),
		issuetype: Named,
		status: Named,
		priority: Named,
		assignee: Person,
		reporter: Person,
		labels: z.array(z.string()).default([]),
		components: z.array(z.object({ name: z.string() })).default([]),
		parent: NestedIssue.nullish(),
		created: Time,
		updated: Time,
		comment: z.object({ comments: z.array(RawComment).default([]) }).nullish(),
		issuelinks: z
			.array(
				z.object({
					type: z.object({ inward: z.string(), outward: z.string() }),
					inwardIssue: NestedIssue.optional(),
					outwardIssue: NestedIssue.optional(),
				}),
			)
			.default([]),
		subtasks: z.array(NestedIssue).default([]),
		attachment: z.array(RawAttachment).default([]),
	}),
	/** The rich text fields as HTML, which Jira renders the same way on Cloud and Data Center. */
	renderedFields: z
		.object({
			description: z.string().nullish(),
			comment: z.object({ comments: z.array(z.object({ id: z.string(), body: z.string().nullish() })).default([]) }).nullish(),
		})
		.default({}),
})
export type RawIssue = z.infer<typeof RawIssue>

/** The fields `getIssue` asks for: what {@link RawIssue} reads. */
export const issueFields = [
	'summary',
	'issuetype',
	'status',
	'priority',
	'assignee',
	'reporter',
	'labels',
	'components',
	'parent',
	'created',
	'updated',
	'description',
	'comment',
	'issuelinks',
	'subtasks',
	'attachment',
]

/** The fields a search asks for, for each issue it finds. */
export const searchFields = ['summary', 'status', 'issuetype']

/** An issue a search found, as Jira hands it back. */
export const RawFoundIssue = z.object({
	key: z.string(),
	fields: z.object({ summary: z.string().default(''), status: Named, issuetype: Named }),
})
export type RawFoundIssue = z.infer<typeof RawFoundIssue>
