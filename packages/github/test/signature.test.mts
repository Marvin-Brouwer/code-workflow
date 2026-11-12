import { describe, expect, test } from 'vitest'
import { runIdLine, signed, unsigned, withoutRunId } from '../src/host/signature.mts'

const runId = 'run-1'
const sha = 'a'.repeat(40)

describe('unsigned', () => {
	test('cuts the footer and its markers', () => {
		// Arrange
		const body = signed('Sets it.', runId, [`described:${sha}`], ['Fixes #7'])

		// Act
		const text = unsigned(body)

		// Assert
		expect(text).toBe('Sets it.')
	})

	test('cuts the footer of a body saved with CRLF', () => {
		// Arrange
		const body = signed('Sets it.\n\nOn the cookie.', runId, [`described:${sha}`]).replaceAll('\n', '\r\n')

		// Act
		const text = unsigned(body)

		// Assert
		expect(text).toBe('Sets it.\n\nOn the cookie.')
	})

	test('keeps what a person wrote under the footer, as a paragraph of its own', () => {
		// Arrange
		const body = `${signed('Sets it.', runId, [`described:${sha}`])}\nAdded later.`

		// Act
		const text = unsigned(body)

		// Assert
		expect(text).toBe('Sets it.\n\nAdded later.')
	})

	test("keeps a person's own `---` rule", () => {
		// Arrange
		const body = 'Sets it.\n\n---\nNotes of my own.'

		// Act
		const text = unsigned(body)

		// Assert
		expect(text).toBe(body)
	})
})

describe('runIdLine', () => {
	test('gives the run id line of the footer, with the notes next to the run id', () => {
		// Arrange
		const body = signed('Sets it.\n\n---\nNotes.', runId, [], ['Fixes #7'])

		// Act
		const line = runIdLine(body)

		// Assert
		expect(line).toBe('`run-1` Fixes #7')
	})

	test('gives nothing for a body without the footer', () => {
		// Arrange
		const body = 'Sets it.\n\nFixes #7'

		// Act
		const line = runIdLine(body)

		// Assert
		expect(line).toBeUndefined()
	})
})

describe('withoutRunId', () => {
	test('takes the run id out of the footer and keeps the notes next to it', () => {
		// Arrange
		const body = signed('Sets it.', runId, [], ['Fixes #7']).replaceAll('\n', '\r\n')

		// Act
		const text = withoutRunId(body)

		// Assert
		expect(text.split('\n').at(-1)).toBe(' Fixes #7')
		expect(text).not.toContain(runId)
	})
})
