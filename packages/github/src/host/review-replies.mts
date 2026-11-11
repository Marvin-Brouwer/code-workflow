import type { Octokit } from '@octokit/rest'
import { splitRepositoryName } from '../repository-name.mts'
import { commentMarker, type PostedComment } from '../tools/issue-tools.mts'
import type { ReviewItemKind } from '../tools/pull-request-tools.mts'
import { pageSize } from './api.mts'

/** The marker key every reply this package posts carries, so a look at the review never hands it back as a reviewer's. */
export const replyKey = 'reply'

/** The marker key of the reply that says `item` is being read, until the answer replaces it. */
export const seenKey = (item: string) => `seen:${item}`

/** The marker key of the answer that replaced the reply that said `item` was being read, so `item` isn't shown again. */
export const answeredKey = (item: string) => `answered:${item}`

/** The marker key, `reaction:<id>`, of the 👀 reaction the reply that says an item is being read put on it. */
export const reactionKey = 'reaction'

/** The reaction that says a comment is being read. */
const beingRead = 'eyes'

/** What the reply that says an item is being read says: a link on the conversation, where it isn't next to the item. */
export function readingNote(kind: ReviewItemKind, url: string): string {
	return kind === 'review-comment' ? '👀 Reading...' : `👀 Reading [this ${kind}](${url})...`
}

/** A reply this package posted on a pull request: in a line comment's thread, or on the conversation. */
export interface OwnReply {
	readonly id: number
	readonly body: string
}

/**
 * Where the connector answers review items on one pull request: in the thread of a comment on a
 * line, or on the conversation for everything else. `kind` is the kind of the item answered.
 */
export interface PullRequestComments {
	/** The replies this package posted where items of `kinds` are answered, read in one listing per place. */
	ownReplies(kinds: readonly ReviewItemKind[]): Promise<readonly OwnReply[]>
	/** Puts 👀 on comment `commentId` and returns the reaction's id. A review takes no reactions on GitHub. */
	react(kind: ReviewItemKind, commentId: number): Promise<number | undefined>
	/** Takes reaction `reaction` off comment `commentId`. One that's gone already is fine. */
	unreact(kind: ReviewItemKind, commentId: number, reaction: number): Promise<void>
	/** The first comment of the thread line comment `commentId` is in: GitHub only takes replies to that one. */
	threadOf(commentId: number): Promise<number>
	/** Replies where `kind` is answered: in the thread of line comment `threadId`, or on the conversation. */
	post(kind: ReviewItemKind, threadId: number | undefined, body: string): Promise<PostedComment>
	/** Replaces the body of this package's reply `commentId`, where `kind` is answered. */
	edit(kind: ReviewItemKind, commentId: number, body: string): Promise<PostedComment>
}

/** The comments of pull request `number`, through `client`. */
export function pullRequestComments(client: Octokit, repository: string, number: number): PullRequestComments {
	const where = splitRepositoryName(repository)
	const conversation = { ...where, issue_number: number }
	return Object.freeze<PullRequestComments>({
		async ownReplies(kinds) {
			const onLines = kinds.includes('review-comment')
			const onConversation = kinds.some((kind) => kind !== 'review-comment')
			const [lineComments, comments] = await Promise.all([
				onLines ? client.paginate(client.rest.pulls.listReviewComments, { ...where, pull_number: number, per_page: pageSize }) : [],
				onConversation ? client.paginate(client.rest.issues.listComments, { ...conversation, per_page: pageSize }) : [],
			])
			return [
				...lineComments.flatMap(({ id, body }) => (isOwnReply(body) ? [{ id, body }] : [])),
				...comments.flatMap(({ id, body }) => (isOwnReply(body) ? [{ id, body }] : [])),
			]
		},
		async react(kind, commentId) {
			const reaction = { ...where, comment_id: commentId, content: beingRead } as const
			if (kind === 'review-comment') return (await client.rest.reactions.createForPullRequestReviewComment(reaction)).data.id
			if (kind === 'comment') return (await client.rest.reactions.createForIssueComment(reaction)).data.id
			return undefined
		},
		async unreact(kind, commentId, reaction) {
			const which = { ...where, comment_id: commentId, reaction_id: reaction }
			// Best effort: the reviewer may have taken it off, or deleted the comment, and the answer matters more.
			const taken =
				kind === 'review-comment'
					? client.rest.reactions.deleteForPullRequestComment(which)
					: client.rest.reactions.deleteForIssueComment(which)
			await taken.catch(() => undefined)
		},
		async threadOf(commentId) {
			const { data } = await client.rest.pulls.getReviewComment({ ...where, comment_id: commentId })
			return data.in_reply_to_id ?? data.id
		},
		async post(kind, threadId, body) {
			if (kind === 'review-comment' && threadId !== undefined)
				return posted(
					(await client.rest.pulls.createReplyForReviewComment({ ...where, pull_number: number, comment_id: threadId, body })).data,
				)
			return posted((await client.rest.issues.createComment({ ...conversation, body })).data)
		},
		async edit(kind, commentId, body) {
			if (kind === 'review-comment')
				return posted((await client.rest.pulls.updateReviewComment({ ...where, comment_id: commentId, body })).data)
			return posted((await client.rest.issues.updateComment({ ...where, comment_id: commentId, body })).data)
		},
	})
}

/** Whether a comment's body is a reply this package posted. */
function isOwnReply(body: string | null | undefined): body is string {
	return body?.includes(commentMarker(replyKey)) === true
}

/** What the connector says about a comment it posted or edited. */
function posted(data: { id: number; html_url: string }): PostedComment {
	return { id: data.id, url: data.html_url }
}
