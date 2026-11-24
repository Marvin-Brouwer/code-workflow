import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { duration } from '@mesh-flow/duration'
import { describe, expect, test } from 'vitest'
import { replaceFile, retryingBriefRefusals } from '../src/files/replace-file.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** A signal that never aborts. */
const abortSignal = new AbortController().signal

/** How long a stopped retry may take to settle. */
const promptly = duration.of('1s')

/** How many tries make about 3 s. */
const triesInAll = 20

/** An error as Node gives it, with its code. */
function codedError(code: string): Error {
	return Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
}

/** An operation that is refused with `code` the first `refusals` times. */
function refusedAtFirst(code: string, refusals: number): { readonly operation: () => Promise<void>; readonly attempts: () => number } {
	let attempts = 0
	return {
		operation: async () => {
			attempts++
			if (attempts <= refusals) throw codedError(code)
		},
		attempts: () => attempts,
	}
}

describe('replaceFile', () => {
	test('replaces the file with the new text', async () => {
		// Arrange
		const file = path.join(await temporaryDirectory(), 'settings.json')
		await replaceFile(file, 'old', { abortSignal: abortSignal })

		// Act
		await replaceFile(file, 'new', { mode: 0o600, abortSignal: abortSignal })

		// Assert
		expect(await readFile(file, 'utf8')).toBe('new')
	})
})

describe('retryingBriefRefusals', () => {
	test('tries again on Windows while the rename is refused for a moment', async () => {
		// Arrange
		const refused = refusedAtFirst('EPERM', 2)

		// Act
		await retryingBriefRefusals(refused.operation, 'win32', abortSignal)

		// Assert
		expect(refused.attempts()).toBe(3)
	})

	test('fails at once elsewhere, where the same code is no passing refusal', async () => {
		// Arrange
		const refused = refusedAtFirst('EACCES', 1)

		// Act
		const replacing = retryingBriefRefusals(refused.operation, 'linux', abortSignal)

		// Assert
		await expect(replacing).rejects.toThrow('EACCES')
		expect(refused.attempts()).toBe(1)
	})

	test('fails at once on another error', async () => {
		// Arrange
		const refused = refusedAtFirst('ENOSPC', 1)

		// Act
		const replacing = retryingBriefRefusals(refused.operation, 'win32', abortSignal)

		// Assert
		await expect(replacing).rejects.toThrow('ENOSPC')
		expect(refused.attempts()).toBe(1)
	})

	test('gives up after about 3 s of refusals', async () => {
		// Arrange
		const refused = refusedAtFirst('EBUSY', Number.POSITIVE_INFINITY)

		// Act
		const replacing = retryingBriefRefusals(refused.operation, 'win32', abortSignal)

		// Assert
		await expect(replacing).rejects.toThrow('EBUSY')
		expect(refused.attempts()).toBe(triesInAll)
	})

	test('settles promptly when stopped between tries', async () => {
		// Arrange
		const refused = refusedAtFirst('EPERM', Number.POSITIVE_INFINITY)
		const stop = new AbortController()
		const started = Date.now()

		// Act
		const replacing = retryingBriefRefusals(refused.operation, 'win32', stop.signal)
		stop.abort(new Error('The run was stopped.'))

		// Assert
		await expect(replacing).rejects.toThrow('The run was stopped.')
		expect(Date.now() - started).toBeLessThan(promptly.to('ms'))
	})
})
