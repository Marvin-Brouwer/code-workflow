import { describe, expect, test } from 'vitest'
import { quoteHeader } from '../src/host/reply-quote.mts'

const url = 'https://github.example/team/app/pull/3#issuecomment-4'
const at = '2026-11-16T05:37:28Z'

describe('quoteHeader', () => {
	test('quotes the item, and links it under the time it was posted', () => {
		// Arrange
		const item = { body: 'Why SameSite=None?', at, url }

		// Act
		const header = quoteHeader(item)

		// Assert
		expect(header).toBe(`Reply to:\n> Why SameSite=None?\n\n[2026-11-16 05:37 UTC](${url})\n\n`)
	})

	test('leaves out what the item quoted itself, and escapes its mentions', () => {
		// Arrange
		const body = '> Earlier words.\r\n\r\nAsk @reviewer, not me@example.com or `@code`.'

		// Act
		const header = quoteHeader({ body, at, url })

		// Assert
		expect(header).toContain('> Ask \\@reviewer, not me@example.com or `@code`.\n\n')
		expect(header).not.toContain('Earlier words.')
	})

	test('cuts a long item short at a word, and a tall one after four lines', () => {
		// Arrange
		const long = `${'word '.repeat(80)}end`
		const tall = ['one', 'two', 'three', 'four', 'five'].join('\n')

		// Act
		const [longQuote = '', tallQuote = ''] = [long, tall].map((body) => quoteHeader({ body, at, url }).split('\n\n')[0])

		// Assert
		expect(longQuote).toMatch(/^Reply to:\n> (word ){55}word…$/u)
		expect(tallQuote).toBe('Reply to:\n> one\n> two\n> three\n> four…')
	})

	test('says what a review without a body did', () => {
		// Arrange
		const review = { body: '', at, url, state: 'APPROVED' }

		// Act
		const header = quoteHeader(review)

		// Assert
		expect(header).toContain('> _Approved, without a comment._\n')
	})
})
