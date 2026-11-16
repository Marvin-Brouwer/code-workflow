import { describe, expect, test } from 'vitest'
import { withHeader, withoutHeader } from '../src/host/reply-header.mts'

describe('withHeader', () => {
	test('puts the header above the reply', () => {
		// Act
		const headed = withHeader('Reply to:\n> Why?', 'Because.')

		// Assert
		expect(headed).toMatch(/^Reply to:\n> Why\?\n\n<!--[^\n]+-->\n\nBecause\.$/u)
	})

	test('leaves a reply without a header as it is', () => {
		// Act
		const plain = withHeader(undefined, 'Because.')

		// Assert
		expect(plain).toBe('Because.')
	})
})

describe('withoutHeader', () => {
	test('gives what the reply says, whatever its header said', () => {
		// Arrange
		const replies = [withHeader('Reply to:\n> Why?', 'Because.'), withHeader('Reply to:\n> Why, though?', 'Because.'), 'Because.']

		// Act
		const said = replies.map(withoutHeader)

		// Assert
		expect(said).toEqual(['Because.', 'Because.', 'Because.'])
	})
})
