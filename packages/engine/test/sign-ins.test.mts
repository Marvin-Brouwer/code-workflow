import { describe, expect, test, vi } from 'vitest'
import type { LoginContext } from '../src/connectors/load-connectors.mts'
import { openSignIns } from '../src/engine/sign-ins.mts'

const abortSignal = new AbortController().signal
const prompt = { url: 'https://device.example/?user_code=ABCD', code: 'ABCD', expiresAt: new Date('2026-11-16T09:10:00Z') }

/** A sign-in that shows {@link prompt} and waits until `approve` is called, or its signal aborts. */
function approvableLogin() {
	const contexts: LoginContext[] = []
	const approvals: Array<() => void> = []
	const login = vi.fn((context: LoginContext) => {
		contexts.push(context)
		context.show(prompt)
		const { promise, resolve, reject } = Promise.withResolvers<undefined>()
		approvals.push(() => {
			resolve(undefined)
		})
		context.abortSignal.addEventListener('abort', () => {
			reject(context.abortSignal.reason)
		})
		return promise
	})
	const approve = () => {
		approvals.at(-1)?.()
	}
	return { login, contexts, approve }
}

describe('sign-ins', () => {
	test('shares one sign-in between everyone who waits for it, and shows where to sign in', async () => {
		// Arrange
		const { login, approve } = approvableLogin()
		const signIns = openSignIns({ connectors: [{ name: 'cloud', login }] })

		// Act
		const waits = [signIns.waitFor('cloud', abortSignal), signIns.waitFor('cloud', abortSignal)]
		const shown = signIns.list()
		approve()
		await Promise.all(waits)

		// Assert
		expect(login).toHaveBeenCalledTimes(1)
		expect(shown).toEqual([
			{ connector: 'cloud', prompt: { url: prompt.url, code: prompt.code, expiresAt: prompt.expiresAt.toISOString() } },
		])
		expect(signIns.list()).toEqual([])
	})

	test('tries again after a failed try, and says why it failed meanwhile', async () => {
		// Arrange
		const { login: approvable, approve } = approvableLogin()
		const login = vi
			.fn<(context: LoginContext) => Promise<void>>()
			.mockRejectedValueOnce(new Error('The code ran out.'))
			.mockImplementation(approvable)
		const signIns = openSignIns({ connectors: [{ name: 'cloud', login }], retryMs: 100 })

		// Act
		const waiting = signIns.waitFor('cloud', abortSignal)
		const failed = await vi.waitFor(() => {
			const listed = signIns.list()
			expect(listed[0]?.error).toBeDefined()
			return listed
		})
		await vi.waitFor(() => {
			expect(login).toHaveBeenCalledTimes(2)
		})
		approve()
		await waiting

		// Assert
		expect(failed).toEqual([{ connector: 'cloud', error: 'The code ran out.' }])
	})

	test('stops the sign-in once nobody waits for it any more', async () => {
		// Arrange
		const { login, contexts } = approvableLogin()
		const signIns = openSignIns({ connectors: [{ name: 'cloud', login }] })
		const first = new AbortController()
		const second = new AbortController()

		// Act
		const waits = [signIns.waitFor('cloud', first.signal), signIns.waitFor('cloud', second.signal)]
		first.abort(new Error('The first run stopped.'))
		const stillUnderWay = contexts[0]?.abortSignal.aborted
		second.abort(new Error('The second run stopped.'))
		const outcomes = await Promise.allSettled(waits)

		// Assert
		expect(stillUnderWay).toBe(false)
		expect(contexts[0]?.abortSignal.aborted).toBe(true)
		expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
		expect(signIns.list()).toEqual([])
	})

	test('refuses a connector that does not sign in', async () => {
		// Arrange
		const signIns = openSignIns({ connectors: [{ name: 'tracker' }] })

		// Act
		const waiting = signIns.waitFor('tracker', abortSignal)

		// Assert
		expect(signIns.has('tracker')).toBe(false)
		await expect(waiting).rejects.toThrow('no connector tracker that signs in')
	})
})
