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

	test('writes a mention as @Name, as Jira Cloud, Jira Data Center and Confluence render it', () => {
		// Arrange
		const mentions = [
			'<p>Ask <a href="https://example.atlassian.net/secure/ViewProfile.jspa?accountId=5b10" class="user-hover" data-account-id="5b10">@Rita Reporter</a>.</p>',
			'<p>Ask <a href="/secure/ViewProfile.jspa?name=rita" class="user-hover" rel="rita">Rita Reporter</a>.</p>',
			'<p>Ask <a href="/wiki/people/5b10" class="confluence-userlink user-mention" data-account-id="5b10">Rita Reporter</a>.</p>',
		]

		// Act
		const markdown = mentions.map(htmlToMarkdown)

		// Assert
		expect(markdown).toEqual(['Ask @Rita Reporter.', 'Ask @Rita Reporter.', 'Ask @Rita Reporter.'])
	})

	test('is empty for no rich text', () => {
		// Act
		const markdown = [htmlToMarkdown(null), htmlToMarkdown(undefined), htmlToMarkdown('  ')]

		// Assert
		expect(markdown).toEqual(['', '', ''])
	})
})
