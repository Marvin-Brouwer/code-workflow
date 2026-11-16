import type { Octokit } from '@octokit/rest'
import { splitRepositoryName } from '../repository-name.mts'
import { ReviewItem, type ReviewItemKind } from '../tools/pull-request-tools.mts'
import { isGone } from './transient-error.mts'

/** How many characters of the item a reply quotes at most. */
const quoteMaxCharacters = 280

/** How many lines of the item a reply quotes at most. */
const quoteMaxLines = 4

/** What ends a quote that was cut short. */
const cutMark = '…'

/** What an item without words of its own is quoted as. */
const withoutWords = '_No comment._'

/** What a review without a body is quoted as, by its verdict. */
const reviewWithoutBody: Partial<Record<NonNullable<ReviewItem['verdict']>, string>> = {
	approved: '_Approved, without a comment._',
	changes_requested: '_Requested changes, without a comment._',
	dismissed: '_A review, dismissed since._',
}

/** The link's text when GitHub gave no time, as for a review that isn't submitted. */
const untimedLinkText = 'link'

/** How long the part of an ISO time up to its minutes is. */
const minuteLength = 'YYYY-MM-DDTHH:MM'.length

/** A line that opens or closes a fenced code block. */
const fence = /^\s*(```|~~~)/u

/**
 * An `@` that starts a mention: not inside a word, as in an email address, and not escaped already.
 * GitHub doesn't notify anyone of an escaped `\@`.
 */
const mention = /(^|[^\w\\])@(?=[\w-])/gu

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
 * The header a reply on the conversation starts with: which item it answers, quoted, and a link to
 * it that reads the time it was posted. GitHub has no threads on the conversation, so without it a
 * reply reads as a comment of its own. The quote leaves out HTML comments and what the item quoted
 * itself, and escapes HTML and mentions outside code: a quote that mentions someone would notify
 * them again, and one cut inside an HTML comment would hide the reply.
 */
export function quoteHeader(item: QuotedItem): string {
	return `Reply to:\n${quoted(item)}\n\n[${postedAt(item.at)}](${item.url})`
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
		const verdict = verdictOf(data.state)
		return quoteHeader({ body: data.body, at: data.submitted_at ?? '', url: data.html_url, ...(verdict === undefined ? {} : { verdict }) })
	} catch (error) {
		if (isGone(error)) return deletedItemHeader(item.kind)
		throw error
	}
}

/** The verdict of a review in GitHub's state, such as `CHANGES_REQUESTED`. */
function verdictOf(state: string): ReviewItem['verdict'] {
	return ReviewItem.shape.verdict.unwrap().safeParse(state.toLowerCase()).data
}

/** The item's own words as a Markdown quote, cut short at a word when they're long. */
function quoted({ body, verdict }: QuotedItem): string {
	const text = ownWords(body)
	if (text === '') return `> ${(verdict === undefined ? undefined : reviewWithoutBody[verdict]) ?? withoutWords}`
	const short = cutAtWord(text.split('\n').slice(0, quoteMaxLines).join('\n'), quoteMaxCharacters)
	const cut = short.length < text.length ? cutMark : ''
	return escapedOutsideCode(`${short}${cut}`)
		.map((line) => `> ${line}`.trimEnd())
		.join('\n')
}

/** `body` without HTML comments, an unclosed one included, and without the lines it quoted, outside code. */
function ownWords(body: string): string {
	let inCode = false
	const lines = body
		.replaceAll('\r\n', '\n')
		.replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, '')
		.split('\n')
		.filter((line) => {
			if (fence.test(line)) inCode = !inCode
			return inCode || !line.trimStart().startsWith('>')
		})
	return lines.join('\n').trim()
}

/** `text` cut at the last whitespace that leaves at most `maxCharacters`, or at `maxCharacters` without one. */
function cutAtWord(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) return text
	const lastSpace = text.slice(0, maxCharacters + 1).search(/\s\S*$/u)
	if (lastSpace > 0) return text.slice(0, lastSpace).trimEnd()
	// Never half a character: a cut after the first half of a surrogate pair takes it off too.
	const end = /[\uD800-\uDBFF]/u.test(text.charAt(maxCharacters - 1)) ? maxCharacters - 1 : maxCharacters
	return text.slice(0, end)
}

/** The lines of `text`, with HTML and mentions escaped outside code blocks and code spans. */
function escapedOutsideCode(text: string): string[] {
	let inCode = false
	return text.split('\n').map((line) => {
		if (fence.test(line)) {
			inCode = !inCode
			return line
		}
		if (inCode) return line
		const parts = line.split('`')
		// A backtick without its pair is just a backtick: what follows it is plain text.
		const unpaired = parts.length % 2 === 0 ? parts.length - 1 : -1
		return parts.map((part, index) => (index % 2 === 0 || index === unpaired ? escaped(part) : part)).join('`')
	})
}

/** Plain Markdown text with its HTML and mentions escaped. */
function escaped(text: string): string {
	return text.replaceAll('<', '&lt;').replaceAll(mention, '$1\\@')
}

/** A time GitHub gave, as `2026-11-16 05:37 UTC`, or {@link untimedLinkText} for none. */
function postedAt(at: string): string {
	const date = new Date(at)
	if (Number.isNaN(date.getTime())) return untimedLinkText
	return `${date.toISOString().slice(0, minuteLength).replace('T', ' ')} UTC`
}
