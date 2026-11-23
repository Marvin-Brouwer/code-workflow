import { describe, expect, test, vi } from 'vitest'
import { abortable } from '../src/abortable.mts'

function never<Value>(): Promise<Value> {
	return new Promise<Value>(() => undefined)
}

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
	const resolvers: { resolve?: (value: Value) => void } = {}
	const promise = new Promise<Value>((resolve) => {
		resolvers.resolve = resolve
	})
	return {
		promise,
		resolve: (value) => {
			resolvers.resolve?.(value)
		},
	}
}

describe('abortable', () => {
	test('settles with the work when the signal never aborts', async () => {
		// Act
		const result = await abortable(Promise.resolve('done'), new AbortController().signal)

		// Assert
		expect(result).toBe('done')
	})

	test('rejects with the signal reason as soon as it aborts, while the work never settles', async () => {
		// Arrange
		const controller = new AbortController()
		const pending = abortable(never<string>(), controller.signal)

		// Act
		controller.abort(new Error('stop'))

		// Assert
		await expect(pending).rejects.toThrow('stop')
	})

	test('rejects right away when the signal is already aborted', async () => {
		// Act
		const pending = abortable(never<string>(), AbortSignal.abort(new Error('too late')))

		// Assert
		await expect(pending).rejects.toThrow('too late')
	})

	test('hands a result that arrives after the abort to discard', async () => {
		// Arrange
		const controller = new AbortController()
		const { promise: work, resolve: finish } = deferred<string>()
		const discard = vi.fn(() => Promise.resolve())
		const pending = abortable(work, controller.signal, discard)
		controller.abort()
		await expect(pending).rejects.toThrow()

		// Act
		finish('late sandbox')
		await work
		await Promise.resolve()

		// Assert
		expect(discard).toHaveBeenCalledWith('late sandbox')
	})

	test('passes the work rejection on', async () => {
		// Act
		const pending = abortable(Promise.reject(new Error('broken')), new AbortController().signal)

		// Assert
		await expect(pending).rejects.toThrow('broken')
	})
})
