import { describe, expect, onTestFinished, test } from 'vitest'
import { untilAborted } from '../src/until-aborted.mts'

describe('untilAborted', () => {
	test('rejects with the reason of a signal that already aborted, and leaves no rejection of the work unhandled', async () => {
		// Arrange
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason)
		}
		process.on('unhandledRejection', onUnhandled)
		onTestFinished(() => {
			process.off('unhandledRejection', onUnhandled)
		})
		const work = Promise.reject(new Error('The work saw the stop too.'))

		// Act
		const waited = untilAborted(work, AbortSignal.abort(new Error('The run stopped.')))

		// Assert
		await expect(waited).rejects.toThrow('The run stopped.')
		await new Promise((resolve) => setImmediate(resolve))
		expect(unhandled).toEqual([])
	})
})
