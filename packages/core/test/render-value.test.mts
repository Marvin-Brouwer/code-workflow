import { duration } from '@mesh-flow/duration'
import { describe, expect, test } from 'vitest'
import { renderValue } from '../src/render/to-prompt.mts'

describe('renderValue', () => {
	test('renders a duration as its text, not as quoted JSON', async () => {
		// Arrange
		const reviewWithin = duration.of('30m')

		// Act
		const rendered = await renderValue(reviewWithin)

		// Assert
		expect(rendered).toBe('30m')
	})
})
