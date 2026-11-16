import { describe, expect, test } from 'vitest'
import { deletedItemHeader, quoteHeader } from '../src/host/reply-header.mts'

const url = 'https://github.example/team/app/pull/3#issuecomment-4'
const at = '2026-11-16T05:37:28Z'

/** The quote in the header of a reply to `body`, without its first line and the link. */
function quoteOf(body: string): string {
	return quoteHeader({ body, at, url }).split('\n\n')[0]?.replace('Reply to:\n', '') ?? ''
}

describe('quoteHeader', () => {
	test('quotes the item, and links it with the time it was posted', () => {
		// Arrange
		const item = { body: 'Why SameSite=None?', at, url }

		// Act
		const header = quoteHeader(item)

		// Assert
		expect(header).toBe(`Reply to:\n> Why SameSite=None?\n\n[2026-11-16 05:37 UTC](${url})`)
	})

	test('leaves out what the item quoted itself, but keeps a line in code that starts the same', () => {
		// Arrange
		const body = '> Earlier words.\r\n\r\nRun this:\r\n```sh\r\n> npm test\r\n```'

		// Act
		const quote = quoteOf(body)

		// Assert
		expect(quote).toBe('> Run this:\n> ```sh\n> > npm test\n> ```')
	})

	test('escapes mentions and HTML outside code, and leaves code as it is', () => {
		// Arrange
		const body = 'Ask @reviewer, not me@example.com, about <details> and `npm i @types/node <x>`.'

		// Act
		const quote = quoteOf(body)

		// Assert
		expect(quote).toBe('> Ask \\@reviewer, not me@example.com, about &lt;details> and `npm i @types/node <x>`.')
	})

	test('escapes a mention after a backtick that has no pair', () => {
		// Arrange
		const body = 'See `this, @reviewer'

		// Act
		const quote = quoteOf(body)

		// Assert
		expect(quote).toBe('> See `this, \\@reviewer')
	})

	test('leaves out HTML comments, also one the item never closed', () => {
		// Arrange
		const body = '<!-- summary by a bot -->\nLooks fine.\n<!-- an unclosed note'

		// Act
		const quote = quoteOf(body)

		// Assert
		expect(quote).toBe('> Looks fine.')
	})

	test('cuts a long item short at a word', () => {
		// Arrange
		const body = `${'word '.repeat(80)}end`

		// Act
		const quote = quoteOf(body)

		// Assert
		expect(quote).toMatch(/^> (word ){55}word…$/u)
	})

	test('cuts a word that is longer than a quote, but never half a character', () => {
		// Arrange
		const body = `${'a'.repeat(279)}${'🙂'.repeat(10)}`

		// Act
		const quote = quoteOf(body)

		// Assert
		expect(quote).toBe(`> ${'a'.repeat(279)}…`)
	})

	test('cuts a tall item after four lines', () => {
		// Arrange
		const body = ['one', 'two', 'three', 'four', 'five'].join('\n')

		// Act
		const quote = quoteOf(body)

		// Assert
		expect(quote).toBe('> one\n> two\n> three\n> four…')
	})

	test('says what a review without a body did', () => {
		// Arrange
		const review = { body: '', at, url, verdict: 'approved' as const }

		// Act
		const header = quoteHeader(review)

		// Assert
		expect(header).toContain('> _Approved, without a comment._\n')
	})

	test('links an item GitHub gave no time for as a link', () => {
		// Arrange
		const review = { body: 'Pending.', at: '', url }

		// Act
		const header = quoteHeader(review)

		// Assert
		expect(header).toContain(`[link](${url})`)
	})
})

describe('deletedItemHeader', () => {
	test('says the item is gone', () => {
		// Act
		const header = deletedItemHeader('comment')

		// Assert
		expect(header).toBe('Reply to a comment that was deleted since.')
	})
})
