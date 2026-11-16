import { describe, expect, test } from 'vitest'
import { deletedItemHeader, quoteHeader } from '../src/host/reply-header.mts'

const url = 'https://github.example/team/app/pull/3#issuecomment-4'
const at = '2026-11-16T05:37:28Z'

describe('quoteHeader', () => {
	test('quotes the item, and links it with the time it was posted', () => {
		// Arrange
		const item = { body: 'Why SameSite=None?', at, url }

		// Act
		const header = quoteHeader(item)

		// Assert
		expect(header).toBe(`Reply to:\n> Why SameSite=None?\n\n[2026-11-16 05:37 UTC](${url})`)
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
		const item = { body: 'Pending.', at: '', url }

		// Act
		const header = quoteHeader(item)

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
