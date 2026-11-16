import type { Octokit } from '@octokit/rest'
import { splitRepositoryName } from '../repository-name.mts'
import type { ReviewItem, ReviewItemKind } from '../tools/pull-request-tools.mts'
import { markdownQuote } from './markdown-quote.mts'
import { verdictField } from './review-verdict.mts'
import { isGone } from './transient-error.mts'

/** The link's text when GitHub gave no time, as for a review that isn't submitted. */
const untimedLinkText = 'link'

/** How long the part of an ISO time up to its minutes is. */
const minuteLength = 'YYYY-MM-DDTHH:MM'.length

/** The item a reply on the conversation answers, as `quoteHeader` quotes it. */
export interface QuotedItem {
	readonly body: string
	/** When it was posted, as GitHub gives it. */
	readonly at: string
	readonly url: string
	/** A review's verdict, which stands in for its body when it has none. */
	readonly verdict?: ReviewItem['verdict']
}

/**
 * The header a reply on the conversation starts with: which item it answers, quoted (see
 * {@link markdownQuote}), and a link to it that reads the time it was posted. GitHub has no threads
 * on the conversation, so without it a reply reads as a comment of its own.
 */
export function quoteHeader(item: QuotedItem): string {
	return `Reply to:\n${markdownQuote(item.body, item.verdict)}\n\n[${postedAt(item.at)}](${item.url})`
}

/** The header of a reply to an item that was deleted since it was read, which leaves nothing to quote. */
export function deletedItemHeader(kind: ReviewItemKind): string {
	return `Reply to a ${kind} that was deleted since.`
}

/**
 * The header of a reply to item `commentId` of `kind` on pull request `number`, read from GitHub.
 * A comment on a line takes none, since its reply goes in its thread.
 *
 * @throws When GitHub fails the read for another reason than the item being gone, such as a refused
 * token; and, with the stop's reason, when the run stops.
 */
export async function replyHeader(
	client: Octokit,
	repository: string,
	number: number,
	item: { readonly kind: ReviewItemKind; readonly commentId: number },
): Promise<string | undefined> {
	if (item.kind === 'review-comment') return undefined
	const where = splitRepositoryName(repository)
	try {
		if (item.kind === 'comment') {
			const { data } = await client.rest.issues.getComment({ ...where, comment_id: item.commentId })
			return quoteHeader({ body: data.body ?? '', at: data.created_at, url: data.html_url })
		}
		const { data } = await client.rest.pulls.getReview({ ...where, pull_number: number, review_id: item.commentId })
		return quoteHeader({ body: data.body, at: data.submitted_at ?? '', url: data.html_url, ...verdictField(data.state) })
	} catch (error) {
		if (isGone(error)) return deletedItemHeader(item.kind)
		throw error
	}
}

/** A time GitHub gave, as `2026-11-16 05:37 UTC`, or {@link untimedLinkText} for none. */
function postedAt(at: string): string {
	const date = new Date(at)
	if (Number.isNaN(date.getTime())) return untimedLinkText
	return `${date.toISOString().slice(0, minuteLength).replace('T', ' ')} UTC`
}
