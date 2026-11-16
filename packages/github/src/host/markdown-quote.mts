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

/** An HTML comment; an unclosed one runs to the end of the text. */
const htmlComment = /<!--[\s\S]*?(?:-->|$)/gu

/** A line that opens a fenced code block, with the fence: three or more backticks or tildes. */
const openingFence = /^\s*(`{3,}|~{3,})/u

/** Two or more blank lines in a row. */
const blankLines = /\n{3,}/gu

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
 * what the item quoted itself, and escapes HTML and mentions outside code: a quote that mentions
 * someone would notify them again, and one cut inside an HTML comment would hide what follows it.
 * A review without a body is quoted by what its `verdict` says.
 */
export function markdownQuote(body: string, verdict?: ReviewItem['verdict']): string {
	const text = ownWords(body)
	if (text === '') return `> ${(verdict === undefined ? undefined : reviewWithoutBody[verdict]) ?? withoutWords}`
	const short = cutAtWord(text.split('\n').slice(0, quoteMaxLines).join('\n'), quoteMaxCharacters)
	const cut = short.length < text.length ? cutMark : ''
	return escapedOutsideCode(`${short}${cut}`)
		.map((line) => `> ${line}`.trimEnd())
		.join('\n')
}

/** `body` without HTML comments and runs of blank lines, and without the lines it quoted, outside code. */
function ownWords(body: string): string {
	const lines = body.replaceAll('\r\n', '\n').replaceAll(htmlComment, '').split('\n')
	const inCode = inCodeBlock(lines)
	return lines
		.filter((line, index) => inCode[index] === true || !line.trimStart().startsWith('>'))
		.join('\n')
		.replaceAll(blankLines, '\n\n')
		.trim()
}

/**
 * Whether each of `lines` is part of a fenced code block, its fences included. A block closes on a
 * fence of the same character, at least as long as the one that opened it.
 */
function inCodeBlock(lines: readonly string[]): boolean[] {
	const { marks } = lines.reduce<{ readonly open: string | undefined; readonly marks: readonly boolean[] }>(
		({ open, marks: before }, line) => {
			const fence = openingFence.exec(line)?.[1]
			if (open === undefined) return { open: fence, marks: [...before, fence !== undefined] }
			const closes = fence !== undefined && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence
			return { open: closes ? undefined : open, marks: [...before, true] }
		},
		{ open: undefined, marks: [] },
	)
	return [...marks]
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
		return parts.map((part, at) => (at % 2 === 0 || at === unpaired ? escaped(part) : part)).join('`')
	})
}

/** Plain Markdown text with its HTML and mentions escaped. */
function escaped(text: string): string {
	return text.replaceAll('<', '&lt;').replaceAll(mention, '$1\\@')
}
