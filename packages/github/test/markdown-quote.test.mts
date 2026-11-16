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

	test('leaves out HTML comments, also one the item never closed', () => {
		// Arrange
		const body = '<!-- summary by a bot -->\nLooks fine.\n<!-- an unclosed note'

		// Act
		const quote = markdownQuote(body)

		// Assert
		expect(quote).toBe('> Looks fine.')
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
})
