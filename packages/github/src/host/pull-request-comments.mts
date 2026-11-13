import { replyKey, type PostedReply, type ReviewComments } from '@mesh-flow/code-repository/host'
import type { Octokit } from '@octokit/rest'
import { splitRepositoryName } from '../repository-name.mts'
import { commentMarker } from '../tools/issue-tools.mts'
import type { ReviewItemKind } from '../tools/pull-request-tools.mts'
import { pageSize } from './api.mts'
import { isGone } from './transient-error.mts'

/** The reaction that says a comment is being read. */
const beingReadReaction = 'eyes'

/** What the reply that says an item is being read says: a link on the conversation, where it isn't next to the item. */
export function readingNote(kind: ReviewItemKind, url: string): string {
	return kind === 'review-comment' ? '👀 Reading...' : `👀 Reading [this ${kind}](${url})...`
}

/**
 * Where the connector answers review items on one pull request: in the thread of a comment on a
 * line, or on the conversation for everything else. A review takes no reactions on GitHub.
 */
export type PullRequestComments = ReviewComments<ReviewItemKind, number>

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
				...lineComments.flatMap(({ id, body, html_url: url }) => (isOwnReply(body) ? [{ id, body, url }] : [])),
				...comments.flatMap(({ id, body, html_url: url }) => (isOwnReply(body) ? [{ id, body, url }] : [])),
			]
		},
		async react(kind, commentId) {
			const reaction = { ...where, comment_id: commentId, content: beingReadReaction } as const
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
		// GitHub only takes replies to the first comment of a line comment's thread.
		async threadOf(kind, commentId) {
			if (kind !== 'review-comment') return undefined
			const { data } = await client.rest.pulls.getReviewComment({ ...where, comment_id: commentId })
			return data.in_reply_to_id ?? data.id
		},
		isGone,
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
function posted(data: { id: number; html_url: string }): PostedReply {
	return { id: data.id, url: data.html_url }
}
