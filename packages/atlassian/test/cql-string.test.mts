import { describe, expect, test } from 'vitest'
import { cqlString, pageSearchCql } from '../src/host/confluence/cql-string.mts'

describe('cqlString', () => {
	test('quotes a string and escapes quotes and backslashes in it', () => {
		// Act
		const quoted = cqlString('say "hi" \\ bye')

		// Assert
		expect(quoted).toBe('"say \\"hi\\" \\\\ bye"')
	})
})

describe('pageSearchCql', () => {
	test('finds pages with the text, in the space when one is given', () => {
		// Act
		const everywhere = pageSearchCql('release notes', undefined)
		const inSpace = pageSearchCql('release notes', 'TEAM')

		// Assert
		expect(everywhere).toBe('type = page AND text ~ "release notes"')
		expect(inSpace).toBe('type = page AND text ~ "release notes" AND space = "TEAM"')
	})
})
