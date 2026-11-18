import { describe, expect, test } from 'vitest'
import { callOutcome } from '../src/run/call-outcome.mts'

describe('callOutcome', () => {
	test('keeps a string as it is and anything else as JSON', () => {
		// Act
		const text = callOutcome({ output: 'done', title: undefined })
		const record = callOutcome({ output: { issue: 63 }, title: 'Collected issue #63' })

		// Assert
		expect(text).toEqual({ result: 'done' })
		expect(record).toEqual({ result: '{"issue":63}', title: 'Collected issue #63' })
	})

	test('leaves out the result when there is nothing to show', () => {
		// Act
		const outcome = callOutcome({ output: undefined, title: undefined })

		// Assert
		expect(outcome).toEqual({})
	})

	test('puts the length of bytes in their place', () => {
		// Act
		const outcome = callOutcome({ output: { file: Buffer.from('abc'), view: new Uint8Array(5) }, title: undefined })

		// Assert
		expect(outcome).toEqual({ result: '{"file":"(3 bytes)","view":"(5 bytes)"}' })
	})

	test('cuts a long result and says how much is left out', () => {
		// Act
		const { result } = callOutcome({ output: 'x'.repeat(4010), title: undefined })

		// Assert
		expect(result).toBe(`${'x'.repeat(4000)}… (10 more characters)`)
	})

	test("says so when JSON can't hold the result", () => {
		// Arrange
		const cycle: Record<string, unknown> = {}
		cycle['self'] = cycle

		// Act
		const outcome = callOutcome({ output: cycle, title: undefined })

		// Assert
		expect(outcome).toEqual({ result: '(a value JSON can’t show)' })
	})
})
