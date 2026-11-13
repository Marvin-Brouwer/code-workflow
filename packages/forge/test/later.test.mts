import { describe, expect, test } from 'vitest'
import { later } from '../src/host/later.mts'

describe('later', () => {
	test('compares moments, not their text, so an offset or a precision of its own is no problem', () => {
		// Arrange
		const inUtc = '2026-11-13T10:00:00.000Z'
		const anHourOnInAmsterdam = '2026-11-13T12:00:00+01:00'

		// Act
		const latest = later(anHourOnInAmsterdam, inUtc)

		// Assert
		expect(latest).toBe(anHourOnInAmsterdam)
	})

	test('takes the one there is when the other is missing', () => {
		// Arrange

		// Act
		const found = [later(undefined, 'b'), later('a', undefined), later(undefined, undefined)]

		// Assert
		expect(found).toEqual(['b', 'a', undefined])
	})
})
