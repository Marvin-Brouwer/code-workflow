import { z } from 'zod'
import { BranchName, RepositoryName } from '../repository-name.mts'
import { Sha } from './git-tools.mts'
import { PostedComment } from './issue-tools.mts'

/** Names a pull request: its repository and number. */
export const PullRequestRef = z.object({
	repository: RepositoryName,
	number: z.int().positive(),
})
export type PullRequestRef = z.infer<typeof PullRequestRef>

/** A pull request as GitHub has it. */
export const PullRequestData = PullRequestRef.extend({
	title: z.string(),
	url: z.url(),
	state: z.enum(['open', 'closed']),
	merged: z.boolean(),
	head: z.object({ branch: BranchName, sha: Sha }),
	base: BranchName,
})
export type PullRequestData = z.infer<typeof PullRequestData>

/** The kinds of comment a review brings, in the id an agent replies to: `review-comment/12`. */
export const ReviewItemKind = z.enum(['review-comment', 'review', 'comment'])
export type ReviewItemKind = z.infer<typeof ReviewItemKind>

/** The id of a review item: its kind and GitHub's id, as an agent sees and replies to it. */
export const ReviewItemId = z
	.string()
	.regex(/^(review-comment|review|comment)\/\d+$/, 'Use the id of a review item, such as review-comment/12.')
export type ReviewItemId = z.infer<typeof ReviewItemId>

/**
 * Something a reviewer said on a pull request: a comment on a line (`review-comment`), a review
 * with a verdict (`review`) or a comment on the conversation (`comment`).
 */
export const ReviewItem = z.object({
	id: ReviewItemId,
	kind: ReviewItemKind,
	author: z.string(),
	body: z.string(),
	url: z.url(),
	at: z.iso.datetime(),
	/** For a review: what the reviewer decided. */
	verdict: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']).optional(),
	/** For a comment on a line: where. */
	path: z.string().optional(),
	line: z.int().optional(),
	/** For a comment on a line: the comment it replies to. */
	inReplyTo: ReviewItemId.optional(),
})
export type ReviewItem = z.infer<typeof ReviewItem>

/** Opens the pull request on the host, or finds the open one for the branch. */
export const openPullRequest = {
	name: 'githubOpenPullRequest',
	description: 'Opens a pull request on GitHub, or returns the open one for the branch',
	input: z.object({ repository: RepositoryName, head: BranchName, base: BranchName, title: z.string().min(1), body: z.string() }),
	output: PullRequestData,
}

/** Reads the pull request on the host. */
export const getPullRequest = {
	name: 'githubPullRequest',
	description: 'Reads a pull request on GitHub',
	input: PullRequestRef,
	output: PullRequestData,
}

/**
 * Lists on the host what was said on the pull request at or after `since`, oldest first. Comments
 * this package posted are left out. An item at the same second as `since` comes again, so the
 * caller keeps the ids it has handled.
 */
export const reviewActivity = {
	name: 'githubReviewActivity',
	description: 'Lists what reviewers said on a pull request since a moment, oldest first',
	input: PullRequestRef.extend({ since: z.iso.datetime().optional() }),
	output: z.object({
		/** Who the credential belongs to, when the token can say; the workflow leaves that author's comments out. */
		self: z.string().optional(),
		items: z.array(ReviewItem),
		/** The moment of the latest item seen so far: the `since` of the next call. Absent until an item was seen. */
		until: z.iso.datetime().optional(),
	}),
}

/** Replies on the host, with a marker in the body so the reply is never listed as a reviewer's item. */
export const replyToReviewItem = {
	name: 'githubReply',
	description: 'Replies to a review item on a pull request: in the thread of a comment on a line, or on the conversation otherwise',
	input: PullRequestRef.extend({ item: ReviewItemId, body: z.string().min(1) }),
	output: PostedComment,
}

/** A check or status on a commit that didn't pass. */
export const CheckFailure = z.object({ name: z.string(), summary: z.string(), url: z.url().optional() })
export type CheckFailure = z.infer<typeof CheckFailure>

/** How far the checks on a commit are: none have been made yet, some are still running, or all are done. */
export const ChecksStatus = z.enum(['none', 'pending', 'completed'])
export type ChecksStatus = z.infer<typeof ChecksStatus>

/** Reads the checks and statuses on a commit on the host. */
export const checksOnRef = {
	name: 'githubChecks',
	description: 'The checks and statuses on a commit of a GitHub repository',
	input: z.object({ repository: RepositoryName, ref: Sha }),
	output: z.object({ status: ChecksStatus, failures: z.array(CheckFailure) }),
}
