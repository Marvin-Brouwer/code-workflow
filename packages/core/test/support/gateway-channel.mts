import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Gateway } from '@mesh-flow/gateway'
import type { Answer, CallMessage } from '@mesh-flow/protocol'
import type { GatewayChannel } from '../../src/gateway/gateway-client.mts'
import { onTestFinished } from 'vitest'
import { untilAborted } from '../../src/run/until-aborted.mts'

/** What else the channel answers besides calls. */
export interface GatewayChannelOptions {
	/** Answers a `login` request once it resolves, as the engine does once the user signed in. Without it, a login is never answered. */
	readonly signIn?: (connector: string) => Promise<void>
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
	onTestFinished(() => rm(staging, { recursive: true, force: true }))
	const stagedFile = (name: string) => path.join(staging, name)
	const answers = new Map<string, PromiseWithResolvers<Answer>>()
	const running = new Map<string, AbortController>()
	const logins = new Map<string, string>()
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
		const value = await accepted.answer(AbortSignal.any([stop.signal, lifetime]))
		const body = accepted.body()
		if (body !== undefined) await writeFile(stagedFile(`${message.id}.body`), body)
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
			answer(message).catch((error: unknown) => {
				slot(message.id).reject(error)
			})
		},
		async take(requestId, abortSignal) {
			const taken = await untilAborted(slot(requestId).promise, abortSignal)
			answers.delete(requestId)
			return taken
		},
		staged: stagedFile,
	}
}
