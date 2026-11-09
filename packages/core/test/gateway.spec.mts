import path from 'node:path'
import {
	hostTool,
	keyFile,
	openCredentialStore,
	openGateway,
	openProviderSettings,
	tokensPerEndpoint,
	type Gateway,
	type HostTool,
} from '@mesh-flow/gateway'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { agent } from '../src/agent/agent.mts'
import { gatewayClient, GatewayCallError } from '../src/gateway/gateway-client.mts'
import { definedHostTools, hostToolStub } from '../src/gateway/host-tool-stub.mts'
import { gatewayChannel } from './support/gateway-channel.mts'
import { runBody } from './support/run-body.mts'
import { callsTool, says, scriptedModel } from './support/scripted-model.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal
const runId = 'run-1'
/** How long a stopped run may take to settle while a host tool never does. */
const promptlyMs = 3_000

const echoDefinition = {
	name: 'echo',
	description: 'Echoes the text',
	input: z.object({ text: z.string() }),
	output: z.object({ echoed: z.string() }),
}
const neverDefinition = { name: 'never', input: z.object({}) }

const echo = hostToolStub(echoDefinition)
const never = hostToolStub(neverDefinition)
/** A stub of a host tool the gateway doesn't have. */
const unlisted = hostToolStub({ name: 'unlisted', input: z.object({}) })

/** Started, and never settles until its call is stopped. */
const neverStarted = vi.fn<(abortSignal: AbortSignal) => void>()
const hostTools: readonly HostTool[] = [
	hostTool(echoDefinition, ({ text }) => Promise.resolve({ echoed: text })),
	hostTool(neverDefinition, (_input, context) => {
		neverStarted(context.abortSignal)
		return new Promise<never>(() => undefined)
	}),
]

/** A gateway in a fresh directory, and what the runtime's side needs to reach it. Records the endpoint of every call. */
async function withGateway(options: { readonly fetch?: typeof fetch } = {}) {
	onTestFinished(() => {
		neverStarted.mockClear()
	})
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	const providers = openProviderSettings(path.join(home, 'providers.json'))
	const opened = openGateway({ home, credentials, providers, tools: hostTools, ...options })
	const calls: { readonly endpoint: string; readonly type: string }[] = []
	const gateway: Gateway = {
		...opened,
		accept(id, message, acceptAbortSignal) {
			calls.push({ endpoint: message.endpoint, type: message.call.type })
			return opened.accept(id, message, acceptAbortSignal)
		},
	}
	const grant = await gateway.openRun(runId, definedHostTools(), abortSignal)
	const client = (lifetime: AbortSignal) => gatewayClient(gatewayChannel(gateway, runId, lifetime), grant, 'test', lifetime)
	return { gateway, credentials, providers, calls, client }
}

/** An Anthropic streamed answer that says `text`. */
function anthropicStream(text: string): string {
	const events = [
		[
			'message_start',
			{
				type: 'message_start',
				message: {
					id: 'msg_1',
					type: 'message',
					role: 'assistant',
					model: 'claude-opus-5-5',
					content: [],
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		],
		['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
		['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
		['content_block_stop', { type: 'content_block_stop', index: 0 }],
		['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
		['message_stop', { type: 'message_stop' }],
	] as const
	return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

describe('gateway', () => {
	test('lists every host tool stub, for the app to take', () => {
		// Act
		const tools = definedHostTools()

		// Assert
		expect(tools).toEqual(['echo', 'never', 'unlisted'])
	})

	test('runs a host tool called from code on the run endpoint', async () => {
		// Arrange
		const { client, calls } = await withGateway()

		// Act
		const run = await runBody(() => echo({ text: 'hi' }), { gateway: client })

		// Assert
		expect(await run.result).toEqual({ echoed: 'hi' })
		expect(calls).toEqual([{ endpoint: 'run', type: 'tool' }])
	})

	test("rejects with the host's error when the host says no", async () => {
		// Arrange
		const { client } = await withGateway()

		// Act
		const run = await runBody(() => unlisted({}), { gateway: client })

		// Assert
		await expect(run.result).rejects.toThrow(GatewayCallError)
	})

	test("runs an agent's host tool on the loop's own endpoint, and closes it after the loop", async () => {
		// Arrange
		const { client, calls } = await withGateway()
		const model = scriptedModel([callsTool('echo', { text: 'from the agent' }), says('done')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Echo with ${echo}.`, { models: model.models, gateway: client })
		await run.result

		// Assert
		expect(JSON.stringify(model.requests[1]?.messages)).toContain('from the agent')
		await vi.waitFor(() => {
			expect(calls.map((call) => call.type)).toEqual(['open', 'tool', 'close'])
		})
		expect(calls[1]?.endpoint).toMatch(/^loop-/)
	})

	test("runs a model through the gateway with the provider's key, and counts what it used", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(anthropicStream('Paris'), { headers: { 'content-type': 'text/event-stream' } })),
		)
		const { client, credentials, providers, gateway } = await withGateway({ fetch: sent })
		await providers.put({ name: 'work', kind: 'anthropic' }, abortSignal)
		await credentials.set('provider/work', 'sk-real', abortSignal)
		const helper = agent({ model: 'claude-opus-5-5' })

		// Act
		const run = await runBody(() => helper.loop`What is the capital of France?`, { gateway: client })

		// Assert
		expect(await run.result).toBe('Paris')
		const [, init] = sent.mock.calls[0] ?? []
		expect(init?.headers).toMatchObject({ 'x-api-key': 'sk-real' })
		expect(await gateway.usage(runId, abortSignal)).toMatchObject({ 'claude-opus-5-5': { requests: 1, inputTokens: 10, outputTokens: 4 } })
	})

	test('settles promptly when the run stops while a host tool never settles, and stops the tool', async () => {
		// Arrange
		const { client } = await withGateway()
		const run = await runBody(() => never({}), { gateway: client })
		await vi.waitFor(() => {
			expect(neverStarted).toHaveBeenCalled()
		})
		const started = Date.now()

		// Act
		run.controller.abort(new Error('stop'))

		// Assert
		expect(await run.outcome).toMatchObject({ status: 'failed' })
		expect(Date.now() - started).toBeLessThan(promptlyMs)
		expect(neverStarted.mock.calls[0]?.[0].aborted).toBe(true)
	})

	test('settles promptly when the run stops while calls wait for a token, every token held by a call that never settles', async () => {
		// Arrange
		const { client } = await withGateway()
		const callsAtOnce = tokensPerEndpoint + 2
		const run = await runBody(() => Promise.all(Array.from({ length: callsAtOnce }, () => never({}))), { gateway: client })
		await vi.waitFor(() => {
			expect(neverStarted).toHaveBeenCalledTimes(tokensPerEndpoint)
		})
		const started = Date.now()

		// Act
		run.controller.abort(new Error('stop'))

		// Assert
		expect(await run.outcome).toMatchObject({ status: 'failed' })
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})
})
