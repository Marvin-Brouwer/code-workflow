import { describe, expect, test } from 'vitest'
import { titleOf } from '../src/tool/title-of.mts'

/** A tool's `describe`: says what the call gave. */
const saysWhatItGave = (input: string, output: number) => `${input} gave ${String(output)}`

/** A tool's `describe` with a bug in it. */
const throwsInstead = (): string => {
	throw new Error('no line')
}

describe('titleOf', () => {
	test("gives the describe's line", () => {
		// Act
		const title = titleOf(saysWhatItGave, 'four', 4)

		// Assert
		expect(title).toBe('four gave 4')
	})

	test('gives no title without a describe', () => {
		// Act
		const title = titleOf(undefined, 'four', 4)

		// Assert
		expect(title).toBeUndefined()
	})

	test('gives no title, rather than a throw, when describe throws', () => {
		// Act
		const title = titleOf(throwsInstead, 'four', 4)

		// Assert
		expect(title).toBeUndefined()
	})
})
