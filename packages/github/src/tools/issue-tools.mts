export { commentMarker, isMarked, markerStart, markerValue } from '@mesh-flow/code-repository'
import { z } from 'zod'
import { RepositoryName } from '../repository-name.mts'

/** Names an issue: its repository and number. What a workflow takes as a parameter. */
export const IssueRef = z.object({
	repository: RepositoryName,
	number: z.int().positive(),
})
export type IssueRef = z.infer<typeof IssueRef>

/** An issue as GitHub has it. */
export const IssueData = z.object({
	repository: RepositoryName,
	number: z.int().positive(),
	title: z.string(),
	body: z.string(),
	state: z.enum(['open', 'closed']),
	labels: z.array(z.string()),
	author: z.string(),
	url: z.url(),
	createdAt: z.iso.datetime(),
})
export type IssueData = z.infer<typeof IssueData>

/** A comment that was posted or updated. */
export const PostedComment = z.object({ id: z.int(), url: z.url() })
export type PostedComment = z.infer<typeof PostedComment>

/** Reads an issue on the host; the sandbox gets its fields, never the credential. */
export const getIssue = {
	name: 'githubIssue',
	description: 'Reads a GitHub issue',
	input: IssueRef,
	output: IssueData,
}

/** Posts a comment on the host, or updates the one that carries the same `key`. */
export const commentOnIssue = {
	name: 'githubCommentIssue',
	description: 'Comments on a GitHub issue or pull request. With a key, a later comment with the same key updates the earlier one.',
	input: IssueRef.extend({ body: z.string().min(1), key: z.string().min(1).optional() }),
	output: PostedComment,
}

/** Adds labels on the host. */
export const labelIssue = {
	name: 'githubLabelIssue',
	description: 'Adds labels to a GitHub issue',
	input: IssueRef.extend({ labels: z.array(z.string().min(1)).min(1) }),
	output: z.object({ labels: z.array(z.string()) }),
}

/** Closes the issue on the host. */
export const closeIssue = {
	name: 'githubCloseIssue',
	description: 'Closes a GitHub issue',
	input: IssueRef,
	output: z.object({ state: z.enum(['open', 'closed']) }),
}
