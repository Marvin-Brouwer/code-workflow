import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Gateway } from '@mesh-flow/gateway'
import { stagedFileName, type Answer, type CallMessage, type LoginAnswer } from '@mesh-flow/protocol'

/** What the engine answers a resumed run's `login` with. */
const resumedAnswer: LoginAnswer = { resumed: true }
import { onTestFinished } from 'vitest'
import type { GatewayChannel } from '../../src/gateway/gateway-client.mts'
import { untilAborted } from '../../src/run/until-aborted.mts'

/** How long the end of a test waits for the calls still being answered. */
const settleTimeoutMs = 5_000

/** What else the channel answers besides calls. */
export interface GatewayChannelOptions {
	/** Answers a `login` request once it resolves, as the engine does once the user signed in. Without it, a login is never answered. */
	readonly signIn?: (connector: string) => Promise<void>
	/** How many `login` requests to answer first as a resume does, before `signIn` gets any. Default: none. */
	readonly resumes?: number
	/** Told when the runtime cancels a `login` it asked for. */
	readonly signInCancelled?: (connector: string) => void
}

/**
 * A channel straight to a gateway in this process, as the engine would carry the calls: each call
 * is accepted, answered and settled, a body it fetched is staged in a directory removed when the
 * test ends, and a cancel stops the call it names or drops the sign-in.
 */
export function gatewayChannel(
	gateway: Gateway,
	runId: string,
	lifetime: AbortSignal,
	options: GatewayChannelOptions = {},
): GatewayChannel {
	const staging = mkdtempSync(path.join(tmpdir(), 'mesh-flow-staged-'))
	const answering = new Set<Promise<void>>()
	// The gateway writes a call's run state until the call settles, so the test's directories go
	// only once the calls are done.
	onTestFinished(async () => {
		await untilAborted(Promise.allSettled(answering), AbortSignal.timeout(settleTimeoutMs)).catch(() => undefined)
		await rm(staging, { recursive: true, force: true })
	})
	const stagedFile = (name: string) => path.join(staging, name)
	const answers = new Map<string, PromiseWithResolvers<Answer>>()
	const running = new Map<string, AbortController>()
	const logins = new Map<string, string>()
	let resumesLeft = options.resumes ?? 0
	const slot = (id: string) => {
		const known = answers.get(id)
		if (known !== undefined) return known
		const created = Promise.withResolvers<Answer>()
		created.promise.catch(() => undefined)
		answers.set(id, created)
		return created
	}
	const answer = async (message: CallMessage) => {
		const stop = new AbortController()
		running.set(message.id, stop)
		const accepted = await gateway.accept(runId, message, lifetime)
		const { answer: value, staged } = await accepted.answer(AbortSignal.any([stop.signal, lifetime]))
		if (staged !== undefined) await writeFile(stagedFile(stagedFileName(message.id)), staged)
		await gateway.settle(runId, message.id, lifetime)
		running.delete(message.id)
		slot(message.id).resolve({ value })
	}
	return {
		send(message) {
			if (message.type === 'cancel') {
				running.get(message.id)?.abort(new Error('The runtime cancelled the call.'))
				const connector = logins.get(message.id)
				if (connector !== undefined) options.signInCancelled?.(connector)
			}
			if (message.type === 'request' && message.request.kind === 'login') {
				const { id, connector } = message.request
				logins.set(id, connector)
				if (resumesLeft > 0) {
					resumesLeft--
					slot(id).resolve({ value: resumedAnswer })
					return
				}
				options.signIn?.(connector).then(
					() => {
						slot(id).resolve({})
					},
					(error: unknown) => {
						slot(id).reject(error)
					},
				)
			}
			if (message.type !== 'call') return
			const answered = answer(message).catch((error: unknown) => {
				slot(message.id).reject(error)
			})
			answering.add(answered)
			void answered.finally(() => answering.delete(answered))
		},
		async take(requestId, abortSignal) {
			const taken = await untilAborted(slot(requestId).promise, abortSignal)
			answers.delete(requestId)
			return taken
		},
		staged: stagedFile,
	}
}
