import { z } from 'zod'
import { IssueKey } from './issue-key.mts'

/** Another issue in passing: a parent, a subtask or a linked issue. */
export const RelatedIssue = z.object({
	key: IssueKey,
	summary: z.string(),
	status: z.string(),
})
export type RelatedIssue = z.infer<typeof RelatedIssue>

/** A link to another issue, with the relation read from this issue's side, such as `is blocked by`. */
export const IssueLink = RelatedIssue.extend({ relation: z.string() })
export type IssueLink = z.infer<typeof IssueLink>

/** A comment on an issue, its body as Markdown. */
export const IssueComment = z.object({
	id: z.string(),
	author: z.string(),
	created: z.string(),
	body: z.string(),
})
export type IssueComment = z.infer<typeof IssueComment>

/** An issue as Jira has it, with its description and comments as Markdown. */
export const IssueData = z.object({
	key: IssueKey,
	url: z.url(),
	summary: z.string(),
	type: z.string(),
	status: z.string(),
	priority: z.string().nullable(),
	assignee: z.string().nullable(),
	reporter: z.string().nullable(),
	labels: z.array(z.string()),
	components: z.array(z.string()),
	parent: RelatedIssue.nullable(),
	created: z.string(),
	updated: z.string(),
	description: z.string(),
	comments: z.array(IssueComment),
	links: z.array(IssueLink),
	subtasks: z.array(RelatedIssue),
})
export type IssueData = z.infer<typeof IssueData>

/** Reads an issue on the host, with its comments, links and subtasks; the sandbox gets the fields, never the credential. */
export const getIssue = {
	name: 'jiraIssue',
	description: 'Reads a Jira issue with its comments, links and subtasks',
	input: z.object({ key: IssueKey }),
	output: IssueData,
}

/** A comment that was posted or updated. */
export const PostedComment = z.object({ id: z.string(), url: z.url() })
export type PostedComment = z.infer<typeof PostedComment>

/** Posts a comment on the host, or updates the one posted earlier with the same `key`. */
export const commentOnIssue = {
	name: 'jiraComment',
	description: 'Comments on a Jira issue, in Markdown. With a key, a later comment with the same key updates the earlier one.',
	input: z.object({ key: IssueKey, body: z.string().min(1), commentKey: z.string().min(1).optional() }),
	output: PostedComment,
}

/** Moves an issue to a status on the host, through the transition that leads there. */
export const transitionIssue = {
	name: 'jiraTransition',
	description: 'Moves a Jira issue to a status. Does nothing when it already has that status.',
	input: z.object({ key: IssueKey, status: z.string().trim().min(1) }),
	output: z.object({ status: z.string(), moved: z.boolean() }),
}
