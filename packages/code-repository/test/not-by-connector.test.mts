import { expect, test } from 'vitest'
import { z } from 'zod'
import { commentMarker, markerStart } from '../src/markers.mts'
import { NotByConnector } from '../src/not-by-connector.mts'

test("takes a person's comment, over several lines, and leaves out one a connector marked, also as JSON Schema", () => {
	// Arrange
	const personComment = 'Rename this.\n\nAnd that.'
	const connectorComment = `Renamed both.\n\n${commentMarker('reply')}`
	const { pattern } = z.object({ pattern: z.string() }).parse(z.toJSONSchema(NotByConnector))
	const fitsStructure = (body: string) => new RegExp(pattern, 'u').test(body)

	// Act
	const parsed = [personComment, connectorComment].map((body) => NotByConnector.safeParse(body).success)
	const checked = [personComment, connectorComment].map(fitsStructure)

	// Assert
	expect(parsed).toEqual([true, false])
	expect(checked).toEqual([true, false])
})

test('the marker goes into the pattern as it is, so it holds no regex special characters', () => {
	// Arrange
	const specialCharacters = /[\\^$.*+?()[\]{}|/]/

	// Act
	const special = specialCharacters.test(markerStart)

	// Assert
	expect(special).toBe(false)
})
