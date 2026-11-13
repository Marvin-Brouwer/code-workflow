import { describe, expect, test } from 'vitest'
import { htmlToMarkdown } from '../src/host/html-to-markdown.mts'

describe('htmlToMarkdown', () => {
	test('turns rendered rich text into Markdown and keeps tables as HTML', () => {
		// Arrange
		const html = '<h2>Steps</h2><ul><li>Open <code>/login</code></li></ul><table><tr><td>a</td></tr></table>'

		// Act
		const markdown = htmlToMarkdown(html)

		// Assert
		expect(markdown).toBe('## Steps\n\n-   Open `/login`\n\n<table><tbody><tr><td>a</td></tr></tbody></table>')
	})

	test('is empty for no rich text', () => {
		// Act
		const markdown = [htmlToMarkdown(null), htmlToMarkdown(undefined), htmlToMarkdown('  ')]

		// Assert
		expect(markdown).toEqual(['', '', ''])
	})
})
