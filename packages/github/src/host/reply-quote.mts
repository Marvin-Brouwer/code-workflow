import type { Octokit } from '@octokit/rest'
import { splitRepositoryName } from '../repository-name.mts'
import type { ReviewItemKind } from '../tools/pull-request-tools.mts'
import { isGone } from './transient-error.mts'

/** How much of the item a reply quotes, in characters and in lines. */
const quoteLimit = { characters: 280, lines: 4 }

/** What a review without a body says, by its state. */
const statesWithoutBody: Record<string, string> = {
	APPROVED: '_Approved, without a comment._',
	CHANGES_REQUESTED: '_Requested changes, without a comment._',
	DISMISSED: '_Dismissed._',
}

/** The item a reply on the conversation answers, as `quoteHeader` quotes it. */
export interface QuotedItem {
	readonly body: string
	/** When it was posted, as GitHub gives it. */
	readonly at: string
	readonly url: string
	/** A review's state, which stands in for its body when it has none. */
	readonly state?: string
}

/**
 * The lines a reply on the conversation starts with: which item it answers, quoted, and a link to
 * it under the time it was posted. GitHub has no threads on the conversation, so without them a
 * reply reads as a comment of its own. Lines the item itself quoted are left out, and so are
 * mentions: a quote that mentions someone would notify them again.
 */
export function quoteHeader(item: QuotedItem): string {
	return `Reply to:\n${quoted(item)}\n\n[${postedAt(item.at)}](${item.url})\n\n`
}

/**
 * The header of a reply to item `commentId` of `kind` on pull request `number`, read from GitHub.
 * A comment on a line takes none, since its reply goes in its thread; neither does an item deleted
 * since it was read, which leaves nothing to quote.
 */
export async function replyHeader(
	client: Octokit,
	repository: string,
	number: number,
	item: { readonly kind: ReviewItemKind; readonly commentId: number },
): Promise<string> {
	if (item.kind === 'review-comment') return ''
	const where = splitRepositoryName(repository)
	try {
		if (item.kind === 'comment') {
			const { data } = await client.rest.issues.getComment({ ...where, comment_id: item.commentId })
			return quoteHeader({ body: data.body ?? '', at: data.created_at, url: data.html_url })
		}
		const { data } = await client.rest.pulls.getReview({ ...where, pull_number: number, review_id: item.commentId })
		return quoteHeader({ body: data.body, at: data.submitted_at ?? '', url: data.html_url, state: data.state })
	} catch (error) {
		if (isGone(error)) return ''
		throw error
	}
}

/** The item's own words as a Markdown quote, cut short at a word when they're long. */
function quoted({ body, state }: QuotedItem): string {
	const ownLines = body
		.replaceAll('\r\n', '\n')
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('>'))
	const text = ownLines.join('\n').trim()
	if (text === '') return `> ${statesWithoutBody[state ?? ''] ?? '_No comment._'}`
	const lines = text.split('\n').slice(0, quoteLimit.lines)
	let short = lines.join('\n')
	if (short.length > quoteLimit.characters) {
		const lastSpace = short.lastIndexOf(' ', quoteLimit.characters)
		short = short.slice(0, lastSpace > 0 ? lastSpace : quoteLimit.characters).trimEnd()
	}
	const cut = short.length < text.length ? '…' : ''
	return `${short}${cut}`
		.split('\n')
		.map((line) => `> ${withoutMentions(line)}`.trimEnd())
		.join('\n')
}

/** `line` with every `@name` escaped, so GitHub shows it without notifying anyone. */
function withoutMentions(line: string): string {
	return line.replaceAll(/(^|[^\w`\\])@(?=[\w-])/gu, '$1\\@')
}

/** A time GitHub gave, as `2026-11-16 05:37 UTC`; one it didn't give stays as it is. */
function postedAt(at: string): string {
	const date = new Date(at)
	if (Number.isNaN(date.getTime())) return at === '' ? 'link' : at
	return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
