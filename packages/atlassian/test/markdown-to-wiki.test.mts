import { describe, expect, test } from 'vitest'
import { markdownToWiki } from '../src/host/jira/markdown-to-wiki.mts'

describe('markdownToWiki', () => {
	test('keeps code spans and blocks as they are written, and converts the rest', () => {
		// Arrange
		const markdown = 'Run the `*.mts` tests and see *this*.\n\n```ts\nconst glob = `**/*_test.mts`\n```\n\nThen **merge**.'

		// Act
		const wiki = markdownToWiki(markdown)

		// Assert
		expect(wiki).toBe('Run the {{*.mts}} tests and see _this_.\n\n{code:ts}\nconst glob = `**/*_test.mts`\n{code}\n\nThen *merge*.')
	})

	test('a code block without a language is a plain code block', () => {
		// Act
		const wiki = markdownToWiki('```\nnpm test\n```')

		// Assert
		expect(wiki).toBe('{code}\nnpm test\n{code}')
	})
})
