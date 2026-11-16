import type { ReviewItem } from '../tools/pull-request-tools.mts'

/** How many characters of the item a quote holds at most. */
const quoteMaxCharacters = 280

/** How many lines of the item a quote holds at most. */
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

/** What opens an HTML comment. */
const commentOpening = '<!--'

/** A closed HTML comment. */
const htmlComment = /<!--[\s\S]*?-->/gu

/** A zero-width space, which breaks an HTML comment's opening in code, where `<` can't be escaped. */
const zeroWidthSpace = '\u200B'

/** What a comment's opening is turned into, so it can't open one. */
const brokenCommentOpening = `<!-${zeroWidthSpace}-`

/** A line that opens a fenced code block, with the fence: three or more backticks or tildes. */
const openingFence = /^\s*(`{3,}|~{3,})/u

/** A line that starts a block of its own, a heading, list item, rule or HTML, which ends a quote above it. */
const blockStart = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|(?:[-*_]\s*){3,}$|<)/u

/** Two or more blank lines in a row, also ones that hold only spaces or tabs. */
const blankLines = /\n(?:[ \t]*\n){2,}/gu

/** The last whitespace in a text, with the word after it. */
const lastWhitespace = /\s\S*$/u

/** The first half of a character outside the Basic Multilingual Plane. */
const highSurrogate = /[\uD800-\uDBFF]/u

/**
 * An `@` that starts a mention: not inside a word, as in an email address, and not escaped already.
 * GitHub doesn't notify anyone of an escaped `\@`.
 */
const mention = /(^|[^\w\\])@(?=[\w-])/gu

/**
 * `body` as a Markdown quote, cut short at a word when it's long. It leaves out HTML comments and
 * what the item quoted itself, and escapes HTML, entities and mentions outside code: a quote that
 * mentions someone would notify them again, and one cut inside an HTML comment would hide what
 * follows it. No HTML comment can open in it, in code either, so a quote never holds a connector's
 * marker. A review without a body is quoted by what its `verdict` says.
 */
export function markdownQuote(body: string, verdict?: ReviewItem['verdict']): string {
	const { text: uncommented, cut: commentCut } = withoutHtmlComments(body.replaceAll('\r\n', '\n'))
	const text = ownWords(uncommented)
	if (text === '') return `> ${(verdict === undefined ? undefined : reviewWithoutBody[verdict]) ?? withoutWords}`
	const short = cutAtWord(text.split('\n').slice(0, quoteMaxLines).join('\n'), quoteMaxCharacters)
	const ending = commentCut || short.length < text.length ? cutMark : ''
	return escapedOutsideCode(`${short}${ending}`)
		.map((line) => `> ${line.replaceAll(commentOpening, brokenCommentOpening)}`.trimEnd())
		.join('\n')
}

/**
 * `text` without HTML comments, also ones that only form once another is taken out, and cut where
 * one opens that never closes. `cut` says whether it was cut.
 */
function withoutHtmlComments(text: string): { readonly text: string; readonly cut: boolean } {
	const stripped = text.replaceAll(htmlComment, '')
	if (stripped !== text) return withoutHtmlComments(stripped)
	const unclosed = text.indexOf(commentOpening)
	return unclosed === -1 ? { text, cut: false } : { text: text.slice(0, unclosed), cut: true }
}

/**
 * `body` without the lines it quoted, outside code, with each run of blank lines kept as one. A
 * line right under a quoted one belongs to the quote, as Markdown reads it, up to a blank line or
 * a line that starts a block of its own.
 */
function ownWords(body: string): string {
	const lines = body.split('\n')
	const inCode = inCodeBlock(lines)
	const { kept } = lines.reduce<{ readonly inQuote: boolean; readonly kept: readonly string[] }>(
		({ inQuote, kept: before }, line, index) => {
			if (inCode[index] === true) return { inQuote: false, kept: [...before, line] }
			if (line.trimStart().startsWith('>')) return { inQuote: true, kept: before }
			if (inQuote && line.trim() !== '' && !blockStart.test(line)) return { inQuote: true, kept: before }
			return { inQuote: false, kept: [...before, line] }
		},
		{ inQuote: false, kept: [] },
	)
	return kept.join('\n').replaceAll(blankLines, '\n\n').trim()
}

/**
 * Whether each of `lines` is part of a fenced code block, its fences included. A block closes on a
 * fence of the same character, at least as long as the one that opened it.
 */
function inCodeBlock(lines: readonly string[]): readonly boolean[] {
	const { marks } = lines.reduce<{ readonly open: string | undefined; readonly marks: readonly boolean[] }>(
		({ open, marks: before }, line) => {
			const fence = openingFence.exec(line)?.[1]
			if (open === undefined) return { open: fence, marks: [...before, fence !== undefined] }
			const closes = fence !== undefined && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence
			return { open: closes ? undefined : open, marks: [...before, true] }
		},
		{ open: undefined, marks: [] },
	)
	return marks
}

/** `text` cut at the last whitespace that leaves at most `maxCharacters`, or at `maxCharacters` without one. */
function cutAtWord(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) return text
	const space = text.slice(0, maxCharacters + 1).search(lastWhitespace)
	if (space > 0) return text.slice(0, space).trimEnd()
	// Never half a character: a cut after the first half of a surrogate pair takes it off too.
	return text.slice(0, highSurrogate.test(text.charAt(maxCharacters - 1)) ? maxCharacters - 1 : maxCharacters)
}

/** The lines of `text`, with HTML and mentions escaped outside code blocks and code spans. */
function escapedOutsideCode(text: string): string[] {
	const lines = text.split('\n')
	const inCode = inCodeBlock(lines)
	return lines.map((line, index) => {
		if (inCode[index] === true) return line
		const parts = line.split('`')
		// A backtick without its pair is just a backtick: what follows it is plain text.
		const unpaired = parts.length % 2 === 0 ? parts.length - 1 : -1
		return parts.map((part, partIndex) => (partIndex % 2 === 0 || partIndex === unpaired ? escaped(part) : part)).join('`')
	})
}

/** Plain Markdown text with its HTML, entities and mentions escaped. */
function escaped(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll(mention, '$1\\@')
}
