import { EndpointGrant, type CallAnswer, ModelResponse, ResolvedModel } from '@mesh-flow/protocol'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { hostTool } from '../src/tools/host-tool.mts'
import { abortSignal, callGateway, callOf, testGateway } from './support/test-gateway.mts'

const runId = 'run-1'
/** A token of the right shape that the gateway never handed out. */
const unknownToken = 'x'.repeat(43)

const echo = hostTool({ name: 'echo', input: z.object({ text: z.string() }) }, ({ text }) => Promise.resolve({ echoed: text }))
const secretReader = hostTool({ name: 'readSecret', input: z.object({}) }, (_input, context) =>
	context.credentials.get('service/token', context.abortSignal),
)

/** The token of a grant at `index`, which a test knows is there. */
function tokenOf(grant: EndpointGrant, index = 0): string {
	const token = grant.tokens[index]
	if (token === undefined) throw new Error(`The grant has no token ${String(index)}.`)
	return token
}

function errorOf(answer: CallAnswer | undefined): string {
	if (answer === undefined || answer.outcome.ok) throw new Error('The call worked.')
	return answer.outcome.error
}

function resultOf(answer: CallAnswer): unknown {
	if (!answer.outcome.ok) throw new Error(`The call failed: ${answer.outcome.error}`)
	return answer.outcome.result
}

describe('openGateway', () => {
	test("says which of an app's tools it has no host tool for", async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })

		// Act
		const missing = gateway.missingTools(['echo', 'githubComment', 'githubComment'])

		// Assert
		expect(missing).toEqual(['githubComment'])
	})

	test('runs a host tool with the credential it needs, and hands out the next token', async () => {
		// Arrange
		const { gateway, credentials } = await testGateway({ tools: [secretReader] })
		await credentials.set('service/token', 'host-only', abortSignal)
		const grant = await gateway.openRun(runId, ['readSecret'], abortSignal)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'readSecret', input: {} }),
		)

		// Assert
		expect(resultOf(answer)).toBe('host-only')
		expect(answer.next).toMatch(/^[\w-]{16,}$/)
		expect(grant.tokens).not.toContain(answer.next)
	})

	test('closes every endpoint of the run when a spent token comes again', async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)
		const echoCall = { type: 'tool', tool: 'echo', input: { text: 'hi' } } as const
		await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant, 0), echoCall))

		// Act
		const replayed = await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant, 0), echoCall))
		const afterwards = await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant, 1), echoCall))

		// Assert
		expect(replayed.compromised).toContain('Someone else has the run')
		expect(replayed.answer.next).toBeUndefined()
		expect(afterwards.answer.outcome).toMatchObject({ ok: false })
		expect(afterwards.compromised).toBeDefined()
	})

	test('closes the run when a call that is still running comes again', async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)
		const message = callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'echo', input: { text: 'hi' } })
		await gateway.accept(runId, message, abortSignal)

		// Act
		const replayed = await gateway.accept(runId, message, abortSignal)

		// Assert
		expect(replayed.compromised).toContain('Someone else has the run')
	})

	test.each([
		['call id', 'constructor', 'run'],
		['endpoint', 'call-proto', 'constructor'],
	])('closes the run on a bad token with %s named like an object key', async (_what, id, endpoint) => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })
		await gateway.openRun(runId, ['echo'], abortSignal)

		// Act
		const guessed = await gateway.accept(
			runId,
			callOf(endpoint, unknownToken, { type: 'tool', tool: 'echo', input: { text: 'hi' } }, id),
			abortSignal,
		)

		// Assert
		expect(guessed.compromised).toBeDefined()
	})

	test('refuses a token that was never handed out', async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)

		// Act
		const guessed = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, unknownToken, { type: 'tool', tool: 'echo', input: { text: 'hi' } }),
		)

		// Assert
		expect(guessed.compromised).toBeDefined()
	})

	test("opens a loop's endpoint for its tools only, and closes it", async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo, secretReader] })
		const grant = await gateway.openRun(runId, ['echo', 'readSecret'], abortSignal)
		const opened = await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant, 0), { type: 'open', tools: ['echo'] }))
		const loop = EndpointGrant.parse(resultOf(opened.answer))

		// Act
		const allowed = await callGateway(
			gateway,
			runId,
			callOf(loop.endpoint, tokenOf(loop, 0), { type: 'tool', tool: 'echo', input: { text: 'a' } }),
		)
		const other = await callGateway(
			gateway,
			runId,
			callOf(loop.endpoint, tokenOf(loop, 1), { type: 'tool', tool: 'readSecret', input: {} }),
		)
		const nested = await callGateway(gateway, runId, callOf(loop.endpoint, tokenOf(loop, 2), { type: 'open', tools: ['echo'] }))
		await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant, 1), { type: 'close', endpoint: loop.endpoint }))
		const closed = await callGateway(
			gateway,
			runId,
			callOf(loop.endpoint, tokenOf(loop, 3), { type: 'tool', tool: 'echo', input: { text: 'b' } }),
		)

		// Assert
		expect(resultOf(allowed.answer)).toEqual({ echoed: 'a' })
		expect(other.answer.outcome).toEqual({ ok: false, error: "readSecret isn't one of the tools of this endpoint." })
		expect(errorOf(nested.answer)).toContain('only takes its tools')
		expect(closed.compromised).toContain("doesn't have open")
	})

	test("refuses a loop endpoint for tools the app doesn't list", async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo, secretReader] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)

		// Act
		const opened = await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant), { type: 'open', tools: ['readSecret'] }))

		// Assert
		expect(errorOf(opened.answer)).toContain("doesn't list readSecret")
		expect(opened.answer.next).toBeDefined()
	})

	test('checks the input on the host, whatever the stub checked', async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'echo', input: { text: 1 } }),
		)

		// Assert
		expect(errorOf(answer)).toContain("The input of echo doesn't fit")
	})

	test('answers a call taken before an engine restart as interrupted, with its next token', async () => {
		// Arrange
		const { gateway, home } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)
		const message = callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'echo', input: { text: 'hi' } })
		await gateway.accept(runId, message, abortSignal)
		const { gateway: restarted } = await testGateway({ tools: [echo], home })

		// Act
		const interrupted = await restarted.interrupted(runId, abortSignal)
		const readAgain = await callGateway(restarted, runId, message)
		const next = readAgain.answer.next ?? ''
		const goesOn = await callGateway(
			restarted,
			runId,
			callOf(grant.endpoint, next, { type: 'tool', tool: 'echo', input: { text: 'again' } }),
		)

		// Assert
		expect(interrupted.map((call) => call.id)).toEqual([message.id])
		expect(errorOf(interrupted[0]?.answer)).toContain('engine stopped')
		expect(readAgain.compromised).toBeUndefined()
		expect(readAgain.answer.next).toBe(interrupted[0]?.answer.next)
		expect(resultOf(goesOn.answer)).toEqual({ echoed: 'again' })
	})

	test('lists an interrupted call again on the next resume until its answer is settled', async () => {
		// Arrange
		const { gateway, home } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)
		const message = callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'echo', input: { text: 'hi' } })
		await gateway.accept(runId, message, abortSignal)
		const { gateway: restarted } = await testGateway({ tools: [echo], home })

		// Act
		const cutShort = await restarted.interrupted(runId, abortSignal)
		const resumedAgain = await restarted.interrupted(runId, abortSignal)
		await restarted.settle(runId, message.id, abortSignal)
		const afterSettling = await restarted.interrupted(runId, abortSignal)

		// Assert
		expect(cutShort.map((call) => call.id)).toEqual([message.id])
		expect(resumedAgain).toEqual(cutShort)
		expect(afterSettling).toEqual([])
	})

	test('answers an interrupted call read again as interrupted, until the outbox was read past it', async () => {
		// Arrange
		const { gateway, home } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, ['echo'], abortSignal)
		const message = callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'echo', input: { text: 'hi' } })
		await gateway.accept(runId, message, abortSignal)
		const { gateway: restarted } = await testGateway({ tools: [echo], home })
		await restarted.interrupted(runId, abortSignal)
		await restarted.settle(runId, message.id, abortSignal)

		// Act
		const readAgain = await restarted.accept(runId, message, abortSignal)
		await restarted.forgetInterrupted(runId, abortSignal)
		const readAfterForgetting = await restarted.accept(runId, message, abortSignal)

		// Assert
		expect(readAgain.compromised).toBeUndefined()
		expect(errorOf(await readAgain.answer(abortSignal))).toContain('engine stopped')
		expect(readAfterForgetting.compromised).toBeDefined()
	})

	test('settles a call promptly when it is stopped, even if the tool never does', async () => {
		// Arrange
		const never = hostTool({ name: 'never', input: z.object({}) }, () => new Promise<never>(() => undefined))
		const { gateway } = await testGateway({ tools: [never] })
		const grant = await gateway.openRun(runId, ['never'], abortSignal)
		const accepted = await gateway.accept(
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'never', input: {} }),
			abortSignal,
		)
		const controller = new AbortController()

		// Act
		const answering = accepted.answer(controller.signal)
		controller.abort(new Error('cancelled'))

		// Assert
		const answer = await answering
		expect(errorOf(answer)).toBe('The call was stopped: cancelled')
		expect(answer.next).toBeDefined()
	})
})

const anthropicRequest = {
	provider: 'anthropic',
	model: 'claude-opus-5-5',
	path: '/v1/messages',
	method: 'POST',
	headers: { 'content-type': 'application/json', 'x-api-key': 'from-the-sandbox', 'anthropic-version': '2023-06-01' },
	body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] }),
} as const

async function withAnthropic(fetchImpl: typeof fetch, baseUrl?: string) {
	const setup = await testGateway({ fetch: fetchImpl })
	await setup.providers.put({ name: 'anthropic', kind: 'anthropic', ...(baseUrl === undefined ? {} : { baseUrl }) }, abortSignal)
	await setup.credentials.set('provider/anthropic', 'sk-real', abortSignal)
	const grant = await setup.gateway.openRun(runId, [], abortSignal)
	return { ...setup, grant }
}

describe('model calls', () => {
	test('resolves a model to the first provider that offers it', async () => {
		// Arrange
		const { gateway, providers } = await testGateway()
		await providers.put({ name: 'openai', kind: 'openai' }, abortSignal)
		await providers.put({ name: 'work', kind: 'anthropic' }, abortSignal)
		const grant = await gateway.openRun(runId, [], abortSignal)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'resolve-model', model: 'claude-opus-5-5' }),
		)

		// Assert
		expect(ResolvedModel.parse(resultOf(answer))).toEqual({ provider: 'work', kind: 'anthropic', model: 'claude-opus-5-5' })
	})

	test("sends the request with the provider's key instead of the sandbox's, and counts its usage", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ usage: { input_tokens: 12, output_tokens: 3 } }), {
					headers: { 'content-type': 'application/json' },
				}),
			),
		)
		const { gateway, grant } = await withAnthropic(sent)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'model', request: anthropicRequest }),
		)

		// Assert
		expect(ModelResponse.parse(resultOf(answer)).status).toBe(200)
		const [url, init] = sent.mock.calls[0] ?? []
		expect(url).toEqual(new URL('https://api.anthropic.com/v1/messages'))
		expect(init?.headers).toMatchObject({ 'x-api-key': 'sk-real', 'anthropic-version': '2023-06-01' })
		expect(await gateway.usage(runId, abortSignal)).toMatchObject({ 'claude-opus-5-5': { requests: 1, inputTokens: 12, outputTokens: 3 } })
	})

	test("refuses a path that isn't a model request, so the key does nothing else", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>()
		const { gateway, grant } = await withAnthropic(sent)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'model', request: { ...anthropicRequest, path: '/v1/../v1/organizations/keys' } }),
		)

		// Assert
		expect(errorOf(answer)).toContain("isn't a model request")
		expect(sent).not.toHaveBeenCalled()
	})

	test('refuses a path that climbs out of a base URL with a path of its own', async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>()
		const { gateway, grant } = await withAnthropic(sent, 'https://proxy.example/anthropic')

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'model', request: { ...anthropicRequest, path: '/../../elsewhere/v1/messages' } }),
		)

		// Assert
		expect(errorOf(answer)).toContain("isn't a model request")
		expect(sent).not.toHaveBeenCalled()
	})

	test("sends a model request below a base URL's path, with its query", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')))
		const { gateway, grant } = await withAnthropic(sent, 'https://proxy.example/anthropic/')

		// Act
		await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'model', request: { ...anthropicRequest, path: '/v1/messages?beta=true' } }),
		)

		// Assert
		const [url] = sent.mock.calls[0] ?? []
		expect(url).toEqual(new URL('https://proxy.example/anthropic/v1/messages?beta=true'))
	})

	test("drops the headers that would pick another account for the key's usage", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')))
		const { gateway, grant } = await withAnthropic(sent)
		const headers = { ...anthropicRequest.headers, 'OpenAI-Organization': 'org-other', 'proxy-authorization': 'Basic x' }

		// Act
		await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant), { type: 'model', request: { ...anthropicRequest, headers } }))

		// Assert
		const [, init] = sent.mock.calls[0] ?? []
		expect(Object.keys(init?.headers ?? {})).not.toContain('OpenAI-Organization')
		expect(Object.keys(init?.headers ?? {})).not.toContain('proxy-authorization')
	})

	test('refuses a body for another model than the call names', async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>()
		const { gateway, grant } = await withAnthropic(sent)
		const body = JSON.stringify({ model: 'claude-haiku-5-5', messages: [] })

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'model', request: { ...anthropicRequest, body } }),
		)

		// Assert
		expect(errorOf(answer)).toContain("isn't for model claude-opus-5-5")
		expect(sent).not.toHaveBeenCalled()
	})

	test('says how to set a missing key', async () => {
		// Arrange
		const { gateway, providers } = await testGateway()
		await providers.put({ name: 'anthropic', kind: 'anthropic' }, abortSignal)
		const grant = await gateway.openRun(runId, [], abortSignal)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'model', request: anthropicRequest }),
		)

		// Assert
		expect(errorOf(answer)).toContain('mesh-flow provider key anthropic')
	})

	test("says why each model can't run: offered by no provider, or by one without a key", async () => {
		// Arrange
		const { gateway, providers, credentials } = await testGateway()
		await providers.put({ name: 'work', kind: 'anthropic' }, abortSignal)
		await providers.put({ name: 'spare', kind: 'openai' }, abortSignal)
		await credentials.set('provider/work', 'sk-real', abortSignal)

		// Act
		const unavailable = await gateway.unavailableModels(['claude-opus-5-5', 'gpt-4o', 'no-such-model', 'claude-opus-5-5'], abortSignal)

		// Assert
		expect(unavailable).toEqual([
			expect.stringContaining('mesh-flow provider key spare'),
			'None of the providers (work, spare) offers model no-such-model.',
		])
	})
})
