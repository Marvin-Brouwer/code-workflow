import { duration } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import type { SignInContext } from '../src/connectors/load-connectors.mts'
import { openSignIns, type SignIns, type SignInsOptions } from '../src/engine/sign-ins.mts'
import { approvableSignIn, prompt } from './support/approvable-sign-in.mts'

const abortSignal = new AbortController().signal

/** How long a sign-in nobody waits for goes on in these tests. */
const shortIdle = duration.of('50ms')

/** Sign-ins over `options`, closed when the test ends, so a sign-in a test left idle doesn't go on. */
function testSignIns(options: SignInsOptions): SignIns {
	const signIns = openSignIns(options)
	onTestFinished(() => {
		signIns.close()
	})
	return signIns
}

describe('sign-ins', () => {
	test('shares one sign-in between everyone who waits for it, and shows where to sign in', async () => {
		// Arrange
		const { signIn, approve } = approvableSignIn()
		const signIns = testSignIns({ connectors: [{ name: 'cloud', signIn }] })

		// Act
		const waits = [signIns.waitFor('cloud', abortSignal), signIns.waitFor('cloud', abortSignal)]
		const shown = signIns.list()
		approve()
		await Promise.all(waits)

		// Assert
		expect(signIn).toHaveBeenCalledTimes(1)
		expect(shown).toEqual([
			{ connector: 'cloud', prompt: { url: prompt.url, code: prompt.code, expiresAt: prompt.expiresAt.toISOString() } },
		])
		expect(signIns.list()).toEqual([])
	})

	test('says when a sign-in starts, shows its code and ends, until the listener stops', async () => {
		// Arrange
		const { signIn, approve } = approvableSignIn()
		const signIns = testSignIns({ connectors: [{ name: 'cloud', signIn }] })
		const listening = new AbortController()
		const heard: string[] = []
		signIns.listen((connector) => {
			heard.push(connector)
		}, listening.signal)

		// Act
		const waiting = signIns.waitFor('cloud', abortSignal)
		await vi.waitFor(() => {
			expect(signIns.list()[0]?.prompt).toBeDefined()
		})
		approve()
		await waiting
		const heardWhileListening = heard.length
		listening.abort()
		const stopWaiting = new AbortController()
		const again = signIns.waitFor('cloud', stopWaiting.signal)
		await vi.waitFor(() => {
			expect(signIns.list()).toHaveLength(1)
		})
		stopWaiting.abort()
		await again.catch(() => undefined)

		// Assert
		// Started, showed a code, ended.
		expect(heard).toEqual(['cloud', 'cloud', 'cloud'])
		expect(heard).toHaveLength(heardWhileListening)
	})

	test('tries again after a failed try, and says why it failed meanwhile', async () => {
		// Arrange
		const { signIn: approvable, approve } = approvableSignIn()
		const signIn = vi
			.fn<(context: SignInContext) => Promise<void>>()
			.mockRejectedValueOnce(new Error('The code ran out.'))
			.mockImplementation(approvable)
		const signIns = testSignIns({ connectors: [{ name: 'cloud', signIn }], retryWaits: [duration.of('100ms')] })

		// Act
		const waiting = signIns.waitFor('cloud', abortSignal)
		const failed = await vi.waitFor(() => {
			const listed = signIns.list()
			expect(listed[0]?.error).toBeDefined()
			return listed
		})
		await vi.waitFor(() => {
			expect(signIn).toHaveBeenCalledTimes(2)
		})
		approve()
		await waiting

		// Assert
		expect(failed).toEqual([{ connector: 'cloud', error: 'The code ran out.' }])
	})

	test('waits longer after each try that fails before a code, and starts over once a try got one', async () => {
		// Arrange
		const retryWaits = [duration.of('50ms'), duration.of('100ms'), duration.of('200ms')] as const
		/** Timers may fire up to a millisecond early. */
		const timerSlack = duration.of('1ms')
		const triesBeforeCode = 3
		const triedAt: number[] = []
		const signIn = vi.fn((context: SignInContext) => {
			triedAt.push(Date.now())
			// The try after those gets a code, which runs out; the one after it is approved.
			if (triedAt.length === triesBeforeCode + 1) context.show(prompt)
			return triedAt.length === triesBeforeCode + 2 ? Promise.resolve() : Promise.reject(new Error('The service is down.'))
		})
		const signIns = testSignIns({ connectors: [{ name: 'cloud', signIn }], retryWaits })

		// Act
		await signIns.waitFor('cloud', abortSignal)

		// Assert
		const waited = triedAt.slice(1).map((at, index) => at - (triedAt[index] ?? at))
		expect(waited[0]).toBeGreaterThanOrEqual(retryWaits[0].to('ms') - timerSlack.to('ms'))
		expect(waited[1]).toBeGreaterThanOrEqual(retryWaits[1].to('ms') - timerSlack.to('ms'))
		expect(waited[2]).toBeGreaterThanOrEqual(retryWaits[2].to('ms') - timerSlack.to('ms'))
		expect(waited[3]).toBeLessThan(retryWaits[2].to('ms'))
	})

	test('stops the sign-in a while after nobody waits for it any more', async () => {
		// Arrange
		const { signIn, contexts } = approvableSignIn()
		const signIns = testSignIns({ connectors: [{ name: 'cloud', signIn }], idle: shortIdle })
		const first = new AbortController()
		const second = new AbortController()

		// Act
		const waits = [signIns.waitFor('cloud', first.signal), signIns.waitFor('cloud', second.signal)]
		first.abort(new Error('The first run stopped.'))
		second.abort(new Error('The second run stopped.'))
		const outcomes = await Promise.allSettled(waits)
		const stillUnderWay = !(contexts[0]?.abortSignal.aborted ?? true)

		// Assert
		expect(stillUnderWay).toBe(true)
		expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
		await vi.waitFor(() => {
			expect(contexts[0]?.abortSignal.aborted).toBe(true)
		})
		expect(signIns.list()).toEqual([])
	})

	test('keeps the code of a sign-in nobody waited for a moment, for a package manager that tries again', async () => {
		// Arrange
		const { signIn, approve } = approvableSignIn()
		const signIns = testSignIns({ connectors: [{ name: 'cloud', signIn }] })
		const timedOut = new AbortController()

		// Act
		const first = signIns.waitFor('cloud', timedOut.signal)
		timedOut.abort(new Error('The package manager timed out.'))
		await first.catch(() => undefined)
		const again = signIns.waitFor('cloud', abortSignal)
		approve()
		await again

		// Assert
		expect(signIn).toHaveBeenCalledTimes(1)
	})

	test('stops a sign-in nobody waits for at once when it closes', async () => {
		// Arrange
		const { signIn, contexts } = approvableSignIn()
		const signIns = testSignIns({ connectors: [{ name: 'cloud', signIn }] })
		const stopped = new AbortController()
		const waiting = signIns.waitFor('cloud', stopped.signal)
		stopped.abort(new Error('The run stopped.'))
		await waiting.catch(() => undefined)

		// Act
		signIns.close()

		// Assert
		expect(contexts[0]?.abortSignal.aborted).toBe(true)
		expect(signIns.list()).toEqual([])
	})

	test('refuses a connector that does not sign in', async () => {
		// Arrange
		const signIns = testSignIns({ connectors: [{ name: 'tracker' }] })

		// Act
		const waiting = signIns.waitFor('tracker', abortSignal)

		// Assert
		expect(signIns.has('tracker')).toBe(false)
		await expect(waiting).rejects.toThrow('no connector tracker that signs in')
	})
})
