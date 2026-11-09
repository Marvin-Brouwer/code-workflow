import path from 'node:path'
import { runWorkflow, workflow, type RunChannel, type RunOutcome } from '@mesh-flow/core'
import { keyFile, openCredentialStore, openGateway, openProviderSettings, type Gateway, type HostTool } from '@mesh-flow/gateway'
import type { Answer, CallMessage, RuntimeMessage } from '@mesh-flow/protocol'
import { onTestFinished } from 'vitest'
import { gatewayClient, type GatewayChannel } from '../../../core/src/gateway/gateway-client.mts'
import { definedHostTools } from '../../../core/src/gateway/host-tool-stub.mts'
import { tokenCredential } from '../../src/host/api.mts'
import { temporaryDirectory } from './temporary-directory.mts'

/** The GitHub token the test's credential store holds. */
export const testToken = 'ghp_test'

/** A gateway in a fresh directory with `tools` and the GitHub token set. */
export async function testGateway(tools: readonly HostTool[]): Promise<Gateway> {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	await credentials.set(tokenCredential, testToken, new AbortController().signal)
	return openGateway({ home, credentials, providers: openProviderSettings(path.join(home, 'providers.json')), tools })
}

/**
 * A channel straight to a gateway in this process, as the engine would carry the calls: each call
 * is accepted, answered and settled, and a cancel stops the call it names.
 */
function gatewayChannel(gateway: Gateway, runId: string, lifetime: AbortSignal): GatewayChannel {
	const answers = new Map<string, PromiseWithResolvers<Answer>>()
	const running = new Map<string, AbortController>()
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
		await gateway.settle(runId, message.id, lifetime)
		running.delete(message.id)
		slot(message.id).resolve({ value })
	}
	return {
		send(message) {
			if (message.type === 'cancel') running.get(message.id)?.abort(new Error('The runtime cancelled the call.'))
			if (message.type !== 'call') return
			answer(message).catch((error: unknown) => {
				slot(message.id).reject(error)
			})
		},
		take(requestId, abortSignal) {
			const { promise } = slot(requestId)
			return new Promise((resolve, reject) => {
				abortSignal.addEventListener('abort', () => {
					reject(abortSignal.reason)
				})
				promise.then(
					(taken) => {
						answers.delete(requestId)
						resolve(taken)
					},
					(error: unknown) => {
						reject(error instanceof Error ? error : new Error(String(error)))
					},
				)
			})
		},
	}
}

/** A run of `body` as a workflow on `gateway`, in a workspace of its own. */
export interface TestRun<T> {
	readonly workspace: string
	readonly messages: readonly RuntimeMessage[]
	/** The wake requests the run sent, which the channel answers right away. */
	readonly wakes: number
	readonly controller: AbortController
	readonly outcome: Promise<RunOutcome>
	/** What the body returned, or why it threw. */
	readonly result: Promise<T>
}

/**
 * Runs `body` as a workflow with its host tools on `gateway`, on a channel that answers every
 * wake at once, so a polling loop runs on. The run is stopped when the test ends.
 */
export async function runOnGateway<T>(gateway: Gateway, body: (context: { abortSignal: AbortSignal }) => Promise<T>): Promise<TestRun<T>> {
	const workspace = path.join(await temporaryDirectory(), 'workspace')
	const controller = new AbortController()
	onTestFinished(() => {
		controller.abort(new Error('The test finished.'))
	})
	const messages: RuntimeMessage[] = []
	const answers = new Map<string, PromiseWithResolvers<Answer>>()
	const slot = (id: string) => {
		const known = answers.get(id)
		if (known !== undefined) return known
		const created = Promise.withResolvers<Answer>()
		answers.set(id, created)
		return created
	}
	let wakes = 0
	const channel: RunChannel = {
		send(message) {
			messages.push(message)
			if (message.type === 'request' && message.request.kind === 'wake') {
				wakes++
				slot(message.request.id).resolve({})
			}
		},
		answer(requestId, abortSignal) {
			return new Promise((resolve, reject) => {
				abortSignal.addEventListener('abort', () => {
					reject(abortSignal.reason)
				})
				slot(requestId).promise.then(resolve, reject)
			})
		},
	}
	const runId = `run-${String(Date.now())}`
	const grant = await gateway.openRun(runId, definedHostTools(), controller.signal)
	const { promise: result, resolve, reject } = Promise.withResolvers<T>()
	result.catch(() => undefined)
	const definition = workflow('test', async ({ abortSignal }) => {
		try {
			resolve(await body({ abortSignal }))
		} catch (error) {
			reject(error)
			throw error
		}
	})
	const outcome = runWorkflow(definition, {
		channel,
		abortSignal: controller.signal,
		workspace,
		gateway: gatewayClient(gatewayChannel(gateway, runId, controller.signal), grant, 'test', controller.signal),
	})
	outcome
		.then((ended) => {
			if (ended.status === 'failed') reject(ended.error)
		})
		.catch(() => undefined)
	return {
		workspace,
		messages,
		get wakes() {
			return wakes
		},
		controller,
		outcome,
		result,
	}
}
