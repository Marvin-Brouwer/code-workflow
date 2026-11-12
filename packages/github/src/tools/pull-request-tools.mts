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
	/** The description, without the footer when this package wrote it. */
	description: z.string(),
	/** The commit the description was written for, when this package wrote it. */
	describedSha: Sha.optional(),
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

/** How a pull request names the issue it closes: `#7` in its own repository, `owner/name#7` in another. */
const IssueReference = z.string().regex(/^([\w.-]+\/[\w.-]+)?#\d+$/)

/**
 * Opens the pull request on the host. When the branch already has an open one, updates its title
 * and description, unless it was already described for this commit.
 */
export const openPullRequest = {
	name: 'githubOpenPullRequest',
	description:
		'Opens a pull request on GitHub; when the branch already has an open one, updates its title and description, unless it was already described for this commit',
	input: z.object({
		repository: RepositoryName,
		head: BranchName,
		base: BranchName,
		title: z.string().min(1),
		body: z.string(),
		describedSha: Sha,
		closes: IssueReference.optional(),
	}),
	output: PullRequestData,
}

/**
 * Why `updatePullRequest` wrote nothing. `closed`: a closed pull request keeps its text.
 * `unchanged`: it already said this. `edited`: someone edited it since it was last looked at.
 */
export const UpdateSkip = z.enum(['closed', 'unchanged', 'edited'])
export type UpdateSkip = z.infer<typeof UpdateSkip>

/** Gives an open pull request on the host a new title and description; a closed one is left as it is. */
export const updatePullRequest = {
	name: 'githubUpdatePullRequest',
	description: "Changes a pull request's title and description on GitHub",
	input: PullRequestRef.extend({
		title: z.string().min(1),
		body: z.string(),
		describedSha: Sha.optional(),
		closes: IssueReference.optional(),
		/** What the pull request said when it was last looked at: when it says something else now, someone edited it since, and nothing is written. */
		seen: z.object({ title: z.string(), description: z.string() }).optional(),
	}),
	/** With `skipped` when nothing was written. */
	output: PullRequestData.extend({ skipped: UpdateSkip.optional() }),
}

/** Finds on the host the open pull request of a branch onto a base, when it has one. */
export const findPullRequest = {
	name: 'githubFindPullRequest',
	description: 'Finds the open pull request of a branch on GitHub',
	input: z.object({ repository: RepositoryName, head: BranchName, base: BranchName }),
	output: PullRequestData.nullable(),
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
 * this package posted are left out by their marker, never by author: the token may well be the
 * reviewer's own. An item at the same second as `since` comes again, so the caller keeps the ids
 * it has handled.
 */
export const reviewActivity = {
	name: 'githubReviewActivity',
	description: 'Lists what reviewers said on a pull request since a moment, oldest first',
	input: PullRequestRef.extend({ since: z.iso.datetime().optional() }),
	output: z.object({
		items: z.array(ReviewItem),
		/** The moment of the latest item seen so far: the `since` of the next call. Absent until an item was seen. */
		until: z.iso.datetime().optional(),
	}),
}

/**
 * What a reply to a review item is. `plan`: what will be done about it, before it's done. `answer`
 * (the default): the answer to a question, or what was done.
 */
export const ReplyStage = z.enum(['plan', 'answer'])
export type ReplyStage = z.infer<typeof ReplyStage>

/** The stage of a reply that names none. */
export const defaultReplyStage: ReplyStage = 'answer'

/**
 * Replies on the host, with a footer naming the run and a marker in the body so the reply is never
 * listed as a reviewer's item. The first answer to an item replaces the "👀 Reading..." reply that
 * showed it was being read, and takes the 👀 reaction off the item. A plan replaces the reading reply
 * too but leaves the 👀 on, and the answer after a plan is a reply of its own under it, so the
 * reviewer is notified of it. Replies to one item go one at a time.
 */
/** What came of a reply: the comment posted or edited, or that the item is gone, say deleted since it was read. */
export const ReplyOutcome = z.union([PostedComment, z.object({ gone: z.literal(true) })])
export type ReplyOutcome = z.infer<typeof ReplyOutcome>

export const replyToReviewItem = {
	name: 'githubReply',
	description: 'Replies to a review item on a pull request: in the thread of a comment on a line, or on the conversation otherwise',
	input: PullRequestRef.extend({ item: ReviewItemId, body: z.string().min(1), stage: ReplyStage.optional() }),
	output: ReplyOutcome,
}

/**
 * Shows the reviewer on the host that review items are being read: a 👀 reaction on a comment
 * (GitHub has none for a review), and for every item a "👀 Reading..." reply, in the thread of a
 * comment on a line and on the conversation otherwise, that the first answer to the item replaces.
 * Showing an item twice leaves one reply, and an item that was answered already is left alone. An
 * item GitHub won't take the 👀 on, say a comment deleted since, is left out of `shown`.
 */
export const showBeingRead = {
	name: 'githubShowBeingRead',
	description: 'Shows the reviewer that review items on a pull request are being read',
	input: PullRequestRef.extend({
		items: z.array(
			z.object({
				id: ReviewItemId,
				url: z.url(),
				/** For a comment on a line that replies to another: the thread's first comment, which replies go to. */
				thread: ReviewItemId.optional(),
			}),
		),
	}),
	output: z.object({
		shown: z.array(ReviewItemId),
		/** The items the run answered already, say before it started over: `review` doesn't hand them over again. */
		answered: z.array(ReviewItemId),
	}),
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
