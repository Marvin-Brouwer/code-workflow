import { describe, expect, test } from 'vitest'
import { fenced } from '../src/pull-request/fenced.mts'

describe('fenced', () => {
	test('fences a text with five backticks, or more than the longest run the text holds', () => {
		// Act
		const plain = fenced('No fences here.\n')
		const holdsFences = fenced('``````\ncode\n``````')

		// Assert
		expect(plain).toBe('`````\nNo fences here.\n`````')
		expect(holdsFences).toBe('```````\n``````\ncode\n``````\n```````')
	})
})
