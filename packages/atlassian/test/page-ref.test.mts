import { describe, expect, test } from 'vitest'
import { pageIdOf } from '../src/page/page-ref.mts'

describe('pageIdOf', () => {
	test.each([
		['12345', '12345'],
		[' 12345 ', '12345'],
		['https://example.atlassian.net/wiki/spaces/TEAM/pages/12345/Guidelines', '12345'],
		['https://example.atlassian.net/wiki/spaces/TEAM/pages/12345', '12345'],
		['https://wiki.example.com/pages/viewpage.action?pageId=12345', '12345'],
	])('takes the id from %s', (page, id) => {
		// Act
		const found = pageIdOf(page)

		// Assert
		expect(found).toBe(id)
	})

	test('says what to give for something else', () => {
		// Arrange
		const name = 'Guidelines'

		// Act
		const read = () => pageIdOf(name)

		// Assert
		expect(read).toThrow('Guidelines is neither a Confluence page id nor a page URL with one')
	})
})
