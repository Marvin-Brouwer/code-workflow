import { describe, expect, test } from 'vitest'
import { checkedMissingSettings } from '../src/connectors/checked-missing-settings.mts'

describe('checkedMissingSettings', () => {
	test('keeps missing settings as they are', () => {
		// Arrange
		const returned = [{ message: 'Set github/token.', fix: { kind: 'credential', name: 'github/token' } }]

		// Act
		const settings = checkedMissingSettings('github', returned)

		// Assert
		expect(settings).toEqual(returned)
	})

	test('reads the lines of text of a connector built against an older gateway', () => {
		// Act
		const settings = checkedMissingSettings('github', ["github/token isn't set."])

		// Assert
		expect(settings).toEqual([{ message: "github/token isn't set.", fix: { kind: 'other' } }])
	})

	test("says so when the connector answers with something it can't read", () => {
		// Act
		const settings = checkedMissingSettings('github', { token: false })

		// Assert
		expect(settings).toEqual([
			{ message: "The github connector said what it's missing in a way the engine can't read.", fix: { kind: 'other' } },
		])
	})
})
