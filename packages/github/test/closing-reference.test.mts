import { describe, expect, test } from 'vitest'
import { closingReference } from '../src/pull-request/closing-reference.mts'

describe('closingReference', () => {
	test('names an issue of the same repository by number, and one of another repository by its full name', () => {
		// Act
		const same = closingReference({ repository: 'team/app', number: 7 }, 'team/app')
		const other = closingReference({ repository: 'team/web', number: 3 }, 'team/app')

		// Assert
		expect([same, other]).toEqual(['#7', 'team/web#3'])
	})

	test('names an issue of the same repository by number, whatever the case of its name', () => {
		// Act
		const reference = closingReference({ repository: 'Team/App', number: 7 }, 'team/app')

		// Assert
		expect(reference).toBe('#7')
	})
})
