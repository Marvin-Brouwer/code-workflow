import { vi } from 'vitest'
import type { SignInContext } from '../../src/connectors/load-connectors.mts'

/** Where the sign-ins of {@link approvableLogin} say to sign in. */
export const prompt = { url: 'https://device.example/?user_code=ABCD', code: 'ABCD', expiresAt: new Date('2026-11-16T09:10:00Z') }

/** What {@link approvableLogin} takes. */
export interface ApprovableLoginOptions {
	/** Whether a try rejects once its signal aborts. `false` is a sign-in stuck on the network, which ignores it. Default: true. */
	readonly honoursAbort?: boolean
}

/**
 * A connector's sign-in that shows {@link prompt} and waits until `approve` is called, for its
 * latest try. The contexts of its tries are kept, to see whether their signals aborted.
 */
export function approvableLogin({ honoursAbort = true }: ApprovableLoginOptions = {}) {
	const contexts: SignInContext[] = []
	const approvals: (() => void)[] = []
	const login = vi.fn((context: SignInContext) => {
		contexts.push(context)
		context.show(prompt)
		const { promise, resolve, reject } = Promise.withResolvers<undefined>()
		approvals.push(() => {
			resolve(undefined)
		})
		if (honoursAbort)
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
