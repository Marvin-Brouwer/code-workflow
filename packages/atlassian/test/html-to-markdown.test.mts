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

	test('writes a mention as an @mention call with the id the link holds, as Jira Cloud, Jira Data Center and Confluence render it', () => {
		// Arrange
		const mentions = [
			'<p>Ask <a href="https://example.atlassian.net/secure/ViewProfile.jspa?accountId=5b10" class="user-hover" data-account-id="5b10">@Rita Reporter</a>.</p>',
			'<p>Ask <a href="/secure/ViewProfile.jspa?name=rita" class="user-hover" rel="rita">Rita Reporter</a>.</p>',
			'<p>Ask <a href="/wiki/people/5b10" class="confluence-userlink user-mention" data-account-id="5b10">Rita Reporter</a>.</p>',
		]

		// Act
		const markdown = mentions.map((html) => htmlToMarkdown(html))

		// Assert
		expect(markdown).toEqual([
			'Ask `@mention({ name: "Rita Reporter", id: "5b10" })`.',
			'Ask `@mention({ name: "Rita Reporter", id: "rita" })`.',
			'Ask `@mention({ name: "Rita Reporter", id: "5b10" })`.',
		])
	})

	test('reads an id in a profile link decoded, and a `rel` only on a profile link', () => {
		// Arrange
		const mentions = [
			'<p><a href="/wiki/people/557058%3Aabc" class="user-mention">Rita Reporter</a></p>',
			'<p><a href="/display/~j.doe%40corp" class="confluence-userlink">John Doe</a></p>',
			'<p><a href="https://example.org/" class="user-hover" rel="nofollow">Someone</a></p>',
		]

		// Act
		const markdown = mentions.map((html) => htmlToMarkdown(html))

		// Assert
		expect(markdown).toEqual([
			'`@mention({ name: "Rita Reporter", id: "557058:abc" })`',
			'`@mention({ name: "John Doe", id: "j.doe@corp" })`',
			'`@mention({ name: "Someone" })`',
		])
	})

	test("keeps an image's alt text on one line, with its brackets escaped", () => {
		// Act
		const markdown = htmlToMarkdown('<p><img src="/a.png" alt="the [new]\n  login"></p>')

		// Assert
		expect(markdown).toBe('![the \\[new\\] login](/a.png)')
	})

	test('is empty for no rich text', () => {
		// Act
		const markdown = [htmlToMarkdown(null), htmlToMarkdown(undefined), htmlToMarkdown('  ')]

		// Assert
		expect(markdown).toEqual(['', '', ''])
	})
})
