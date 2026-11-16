import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { minTokenLength, stagedFileName, type Answer, type CallAnswer, type RuntimeMessage } from '@mesh-flow/protocol'
import { describe, expect, test, vi } from 'vitest'
import { gatewayClient, type GatewayChannel } from '../src/gateway/gateway-client.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** A token of the length an endpoint takes, numbered `index`. */
function token(index: number): string {
	return String(index).padStart(minTokenLength, '0')
}

/** A channel whose answers the test gives, and the messages the client sent on it. */
async function heldChannel() {
	const staging = await temporaryDirectory()
	const sent: RuntimeMessage[] = []
	const answers = new Map<string, PromiseWithResolvers<Answer>>()
	const slot = (id: string) => {
		const known = answers.get(id)
		if (known !== undefined) return known
		const created = Promise.withResolvers<Answer>()
		answers.set(id, created)
		return created
	}
	const channel: GatewayChannel = {
		send: (message) => {
			sent.push(message)
		},
		take: async (requestId, takeAbortSignal) => {
			takeAbortSignal.throwIfAborted()
			const { promise, reject } = slot(requestId)
			const onAbort = () => {
				reject(takeAbortSignal.reason)
			}
			takeAbortSignal.addEventListener('abort', onAbort, { once: true })
			try {
				return await promise
			} finally {
				takeAbortSignal.removeEventListener('abort', onAbort)
				answers.delete(requestId)
			}
		},
		staged: (name) => path.join(staging, name),
	}
	return {
		channel,
		sent,
		answer: (id: string, value: CallAnswer) => {
			slot(id).resolve({ value })
		},
	}
}

describe('gatewayClient', () => {
	test('removes the body a package fetch staged when its caller stopped waiting before the answer came', async () => {
		// Arrange
		const { channel, sent, answer } = await heldChannel()
		const grant = { endpoint: 'run', tokens: [token(1)], packages: { endpoint: 'packages', tokens: [token(2)] } }
		const client = gatewayClient(channel, grant, 'test', abortSignal)
		const caller = new AbortController()
		const fetching = client.call(
			client.packages ?? client.run,
			{ type: 'package', request: { registry: 'npm', path: '/left-pad' } },
			caller.signal,
		)
		fetching.catch(() => undefined)
		await vi.waitFor(() => {
			expect(sent.some((message) => message.type === 'call')).toBe(true)
		})
		const callId = sent.find((message) => message.type === 'call')?.id ?? ''
		caller.abort(new Error('The package manager went away.'))
		await expect(fetching).rejects.toThrow('went away')
		const body = channel.staged(stagedFileName(callId))
		await writeFile(body, 'tarball')

		// Act
		answer(callId, {
			next: token(3),
			outcome: { ok: true, result: { status: 200, headers: {}, body: stagedFileName(callId), size: 'tarball'.length } },
		})

		// Assert
		await vi.waitFor(() => {
			expect(existsSync(body)).toBe(false)
		})
		expect(sent).toContainEqual({ type: 'cancel', id: callId })
	})
})
