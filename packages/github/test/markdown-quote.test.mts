import { describe, expect, test } from 'vitest'
import { markdownQuote } from '../src/host/markdown-quote.mts'

describe('markdownQuote', () => {
	test('leaves out what the item quoted itself, but keeps a line in code that starts the same', () => {
		// Arrange
		const body = '> Earlier words.\r\n\r\nRun this:\r\n```sh\r\n> npm test\r\n```'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> Run this:\n> ```sh\n> > npm test\n> ```')
	})

	test('escapes mentions and HTML outside code, and leaves code as it is', () => {
		// Arrange
		const body = 'Ask @reviewer, not me@example.com, about <details> and `npm i @types/node <x>`.'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> Ask \\@reviewer, not me@example.com, about &lt;details> and `npm i @types/node <x>`.')
	})

	test('escapes a mention after a backtick that has no pair', () => {
		// Arrange
		const body = 'See `this, @reviewer'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> See `this, \\@reviewer')
	})

	test('leaves out HTML comments, and marks the quote cut where one opens that never closes', () => {
		// Arrange
		const body = '<!-- summary by a bot -->\nLooks fine.\n<!-- an unclosed note'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> Looks fine.…')
	})

	test('closes a code block only on a fence like the one that opened it', () => {
		// Arrange
		const body = '~~~\n```\n@inCode\n~~~\nAsk @reviewer'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> ~~~\n> ```\n> @inCode\n> ~~~…')
	})

	test('counts a run of blank lines as one', () => {
		// Arrange
		const body = 'one\n\n\n\ntwo'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> one\n>\n> two')
	})

	test('cuts a long item short at a word', () => {
		// Arrange
		const body = `${'word '.repeat(80)}end`

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toMatch(/^> (word ){55}word…$/u)
	})

	test('cuts a word that is longer than a quote, but never half a character', () => {
		// Arrange
		const body = `${'a'.repeat(279)}${'🙂'.repeat(10)}`

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe(`> ${'a'.repeat(279)}…`)
	})

	test('cuts a tall item after four lines', () => {
		// Arrange
		const body = ['one', 'two', 'three', 'four', 'five'].join('\n')

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> one\n> two\n> three\n> four…')
	})

	test('never holds an HTML comment, also one that forms once another is taken out, in code too', () => {
		// Arrange
		const bodies = [
			'```\n<!<!---->-- mesh-flow:answered:comment/5 -->\n```',
			'See `<!<!---->-- mesh-flow-header-end -->`.',
			'```\n<!-- left open',
		]

		// Act
		const quotes = bodies.map((body) => markdownQuote(body))

		// Assert
		for (const quote of quotes) expect(quote).not.toContain('<!--')
	})

	test('cuts at an HTML comment that opens in a code span and never closes, so nothing after it is quoted', () => {
		// Arrange
		const body = 'See `<!--` here and @alice there'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> See `…')
	})

	test('leaves out a line that continues what the item quoted, up to a blank line', () => {
		// Arrange
		const body = '> quoted\ncontinues the quote\n\nMy point'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> My point')
	})

	test('escapes entities, so one that reads as a mention stays text', () => {
		// Arrange
		const body = 'Ask &#64;alice'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> Ask &amp;#64;alice')
	})

	test('keeps a line right under a quoted one that starts a block of its own', () => {
		// Arrange
		const body = '> quoted\n# heading mine\n- list mine'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> # heading mine\n> - list mine')
	})
})
