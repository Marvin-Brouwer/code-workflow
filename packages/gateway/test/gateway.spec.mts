import {
	EndpointGrant,
	type CallAnswer,
	type RunGrant,
	type ConnectorRegistry,
	ModelResponse,
	type PackageRegistry,
	ResolvedModel,
} from '@mesh-flow/protocol'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { packageTokens, type GatewayOptions } from '../src/gateway.mts'
import type { ResolveRegistryFetch } from '../src/packages/connector-registry.mts'
import { fetchPackage, maxPackageBytes } from '../src/packages/fetch-package.mts'
import { hostTool, HostToolTransientError } from '../src/tools/host-tool.mts'
import { SignInNeededError } from '../src/tools/sign-in-needed.mts'
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

/** The run's package endpoint, which a test knows was opened. */
function packagesOf(grant: RunGrant): EndpointGrant {
	if (grant.packages === undefined) throw new Error('The run has no package endpoint.')
	return grant.packages
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
		const grant = await gateway.openRun(runId, { tools: ['readSecret'] }, abortSignal)

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

	test('marks a failure the host tool says may pass as transient, and no other', async () => {
		// Arrange
		const flaky = hostTool({ name: 'flaky', input: z.object({}) }, () => Promise.reject(new HostToolTransientError('write ECONNABORTED')))
		const broken = hostTool({ name: 'broken', input: z.object({}) }, () => Promise.reject(new Error('Bad credentials')))
		const { gateway } = await testGateway({ tools: [flaky, broken] })
		const grant = await gateway.openRun(runId, { tools: ['flaky', 'broken'] }, abortSignal)

		// Act
		const transient = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant, 0), { type: 'tool', tool: 'flaky', input: {} }),
		)
		const permanent = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant, 1), { type: 'tool', tool: 'broken', input: {} }),
		)

		// Assert
		expect(transient.answer.outcome).toEqual({ ok: false, error: 'write ECONNABORTED', transient: true })
		expect(permanent.answer.outcome).toEqual({ ok: false, error: 'Bad credentials' })
	})

	test('says which connector to sign in to when a host tool needs a session', async () => {
		// Arrange
		const needsSession = hostTool({ name: 'needsSession', input: z.object({}) }, () => Promise.reject(new SignInNeededError('aws')))
		const { gateway } = await testGateway({ tools: [needsSession] })
		const grant = await gateway.openRun(runId, { tools: ['needsSession'] }, abortSignal)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(grant.endpoint, tokenOf(grant), { type: 'tool', tool: 'needsSession', input: {} }),
		)

		// Assert
		expect(answer.outcome).toEqual({ ok: false, error: 'Sign in to aws: `mesh-flow login aws`.', signInTo: 'aws' })
	})

	test('closes every endpoint of the run when a spent token comes again', async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)
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
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)
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
		await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)

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
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)

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
		const grant = await gateway.openRun(runId, { tools: ['echo', 'readSecret'] }, abortSignal)
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
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)

		// Act
		const opened = await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant), { type: 'open', tools: ['readSecret'] }))

		// Assert
		expect(errorOf(opened.answer)).toContain("doesn't list readSecret")
		expect(opened.answer.next).toBeDefined()
	})

	test('checks the input on the host, whatever the stub checked', async () => {
		// Arrange
		const { gateway } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)

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
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)
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
		expect(interrupted[0]?.answer.outcome).toMatchObject({ transient: true })
		expect(readAgain.compromised).toBeUndefined()
		expect(readAgain.answer.next).toBe(interrupted[0]?.answer.next)
		expect(resultOf(goesOn.answer)).toEqual({ echoed: 'again' })
	})

	test('lists an interrupted call again on the next resume until its answer is settled', async () => {
		// Arrange
		const { gateway, home } = await testGateway({ tools: [echo] })
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)
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
		const grant = await gateway.openRun(runId, { tools: ['echo'] }, abortSignal)
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
		const grant = await gateway.openRun(runId, { tools: ['never'] }, abortSignal)
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
	const grant = await setup.gateway.openRun(runId, { tools: [] }, abortSignal)
	return { ...setup, grant }
}

describe('model calls', () => {
	test('resolves a model to the first provider that offers it', async () => {
		// Arrange
		const { gateway, providers } = await testGateway()
		await providers.put({ name: 'openai', kind: 'openai' }, abortSignal)
		await providers.put({ name: 'work', kind: 'anthropic' }, abortSignal)
		const grant = await gateway.openRun(runId, { tools: [] }, abortSignal)

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
		const grant = await gateway.openRun(runId, { tools: [] }, abortSignal)

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

/**
 * A run that restores from `registry`, on a gateway that fetches with `sent`, and a call that
 * fetches a path there, each on the next of the grant's tokens.
 */
async function packageRun(
	sent: typeof fetch,
	registry: PackageRegistry = 'npm',
	options: Partial<Pick<GatewayOptions, 'registries'>> & { readonly home?: string } = {},
) {
	const { gateway } = await testGateway({ fetch: sent, ...options })
	const grant = await gateway.openRun(runId, { tools: [], registries: [registry] }, abortSignal)
	let used = 0
	const fetchPath = (path: string, accept?: string) =>
		callGateway(
			gateway,
			runId,
			callOf(packagesOf(grant).endpoint, tokenOf(packagesOf(grant), used++), {
				type: 'package',
				request: { registry, path, ...(accept === undefined ? {} : { accept }) },
			}),
		)
	return { gateway, grant, fetchPath }
}

/** A fetch or a connector stuck on the network, which ignores its signal. */
const never = () => new Promise<never>(() => undefined)

/** A connector's registry, as `@mesh-flow/aws` describes a CodeArtifact repository. */
const cloudRegistry: ConnectorRegistry = {
	connector: 'cloud',
	name: 'cloud packages',
	host: 'packages.cloud.example',
	paths: ['/npm/packages/'],
	settings: { repository: 'packages' },
}

/** Resolves fetches on {@link cloudRegistry} to its host, with a bearer token. */
const cloudResolve = vi.fn<ResolveRegistryFetch>(({ path }) =>
	Promise.resolve({ url: `https://packages.cloud.example${path}`, headers: { authorization: 'Bearer cloud-token' } }),
)

describe('package calls', () => {
	test('fetches a package from the registry and answers with the file its body is staged in', async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response('tarball', { headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'a=b' } })),
		)
		const { fetchPath } = await packageRun(sent)

		// Act
		const { answer, body } = await fetchPath('/left-pad/-/left-pad-1.3.0.tgz', 'application/octet-stream')

		// Assert
		expect(resultOf(answer)).toEqual({
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
			body: expect.stringMatching(/^call-\d+\.body$/) as unknown,
			size: 'tarball'.length,
		})
		expect(body()?.toString('utf8')).toBe('tarball')
		const [url, init] = sent.mock.calls[0] ?? []
		expect(url).toBe('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz')
		expect(init?.headers).toMatchObject({ accept: 'application/octet-stream' })
	})

	test("passes the registry's 404 on: package managers ask for what may not exist", async () => {
		// Arrange
		const { fetchPath } = await packageRun(vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 404 }))))

		// Act
		const { answer } = await fetchPath('/no-such-package')

		// Assert
		expect(resultOf(answer)).toMatchObject({ status: 404 })
	})

	test.each<[PackageRegistry, string]>([
		['npm', '/-/npm/v1/security/advisories/bulk'],
		['npm', '/left-pad/../-/whoami'],
		['npm', '/left-pad/%2e%2e/-/whoami'],
		['npm', '//evil.example/left-pad'],
		['npm', '/\\evil.example/left-pad'],
		['npm', '/left-pad#fragment'],
		['npm', '/'],
		['nuget', '/v3x/index.json'],
		['nuget', '/v3-flatcontainer/../api/v2/package/x'],
		['nuget', '/api/v2/package/newtonsoft.json'],
	])('refuses %s %s, which is no package fetch, and sends nothing', async (registry, path) => {
		// Arrange
		const sent = vi.fn<typeof fetch>()
		const { fetchPath } = await packageRun(sent, registry)

		// Act
		const { answer } = await fetchPath(path)

		// Assert
		expect(errorOf(answer)).toContain("isn't a package fetch")
		expect(sent).not.toHaveBeenCalled()
	})

	test.each([
		'/v3/index.json',
		'/v3-flatcontainer/newtonsoft.json/index.json',
		'/v3/vulnerabilities/index.json',
		'/v3-vulnerabilities/2026.11.16.05.40.00/vulnerability.base.json',
		'/v3-index/repository-signatures/5.0.0/index.json',
	])('fetches %s from nuget.org', async (path) => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')))
		const { fetchPath } = await packageRun(sent, 'nuget')

		// Act
		const { answer } = await fetchPath(path)

		// Assert
		expect(resultOf(answer)).toMatchObject({ status: 200 })
		expect(sent.mock.calls[0]?.[0]).toBe(`https://api.nuget.org${path}`)
	})

	test('hands a redirect back instead of following it, so the next fetch is checked too', async () => {
		// Arrange
		const location = 'https://elsewhere.example/left-pad'
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 302, headers: { location } })))
		const { fetchPath } = await packageRun(sent)

		// Act
		const { answer } = await fetchPath('/left-pad')

		// Assert
		expect(resultOf(answer)).toMatchObject({ status: 302, headers: { location } })
		expect(sent).toHaveBeenCalledOnce()
		expect(sent.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
	})

	test('stops reading a body that grows larger than it takes, and cancels the rest', async () => {
		// Arrange
		const maxBytes = 8
		const cancelled = vi.fn()
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(maxBytes))
			},
			cancel: cancelled,
		})
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response(body)))

		// Act
		const fetching = fetchPackage({ registry: 'npm', path: '/left-pad' }, { fetchFromHost: sent, maxBytes }, abortSignal)

		// Assert
		await expect(fetching).rejects.toThrow('the most a package fetch takes')
		expect(cancelled).toHaveBeenCalledOnce()
	})

	test('settles a package fetch when it is stopped, even if the registry never answers', async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => new Promise<never>(() => undefined))
		const stop = new AbortController()
		const fetching = fetchPackage({ registry: 'npm', path: '/left-pad' }, { fetchFromHost: sent }, stop.signal)
		await vi.waitFor(() => {
			expect(sent).toHaveBeenCalled()
		})

		// Act
		stop.abort(new Error('The run stopped.'))

		// Assert
		await expect(fetching).rejects.toThrow('The run stopped.')
	})

	test('settles a package fetch when it is stopped while the body never comes', async () => {
		// Arrange
		const body = new ReadableStream<Uint8Array>()
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response(body)))
		const stop = new AbortController()
		const fetching = fetchPackage({ registry: 'npm', path: '/left-pad' }, { fetchFromHost: sent }, stop.signal)
		await vi.waitFor(() => {
			expect(sent).toHaveBeenCalled()
		})

		// Act
		stop.abort(new Error('The run stopped.'))

		// Assert
		await expect(fetching).rejects.toThrow('The run stopped.')
	})

	test.each([
		['the host cannot reach the registry', () => Promise.reject(new TypeError('fetch failed'))],
		[
			'the connection drops while the body comes',
			() =>
				Promise.resolve(
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								controller.error(new Error('socket hang up'))
							},
						}),
					),
				),
		],
	])('answers a fetch that failed because %s as one that may pass', async (_what, failing) => {
		// Arrange
		const sent = vi.fn<typeof fetch>(failing)
		const { fetchPath } = await packageRun(sent)

		// Act
		const { answer } = await fetchPath('/left-pad/-/left-pad-1.3.0.tgz')

		// Assert
		expect(answer.outcome).toMatchObject({ ok: false, transient: true })
	})

	test("answers a path that isn't a package fetch as a refusal, which another try won't change", async () => {
		// Arrange
		const { fetchPath } = await packageRun(vi.fn<typeof fetch>())

		// Act
		const { answer } = await fetchPath('/-/whoami')

		// Assert
		expect(answer.outcome).toEqual({ ok: false, error: expect.stringContaining("isn't a package fetch") as unknown })
	})

	test('refuses a body larger than a package fetch takes', async () => {
		// Arrange
		const headers = { 'content-length': String(maxPackageBytes + 1) }
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('too large', { headers })))
		const { fetchPath } = await packageRun(sent)

		// Act
		const { answer } = await fetchPath('/left-pad/-/left-pad-1.3.0.tgz')

		// Assert
		expect(errorOf(answer)).toContain('the most a package fetch takes')
	})

	test("refuses a registry the run's app doesn't restore from", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>()
		const { gateway, grant } = await packageRun(sent)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(packagesOf(grant).endpoint, tokenOf(packagesOf(grant)), {
				type: 'package',
				request: { registry: 'nuget', path: '/v3/index.json' },
			}),
		)

		// Assert
		expect(errorOf(answer)).toContain("doesn't restore from nuget")
		expect(sent).not.toHaveBeenCalled()
	})

	test("refuses package calls on the run's and a loop's endpoint: they go on the package endpoint", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>()
		const { gateway, grant } = await packageRun(sent)
		const { answer: opened } = await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant), { type: 'open', tools: [] }))
		const loop = EndpointGrant.parse(resultOf(opened))
		const request = { registry: 'npm', path: '/left-pad' } as const

		// Act
		const onRun = await callGateway(gateway, runId, callOf(grant.endpoint, tokenOf(grant, 1), { type: 'package', request }))
		const onLoop = await callGateway(gateway, runId, callOf(loop.endpoint, tokenOf(loop), { type: 'package', request }))

		// Assert
		expect([errorOf(onRun.answer), errorOf(onLoop.answer)]).toEqual([
			'Package fetches go on the package endpoint.',
			'Package fetches go on the package endpoint.',
		])
		expect(sent).not.toHaveBeenCalled()
	})

	test('opens a package endpoint with tokens of its own, which takes package fetches only', async () => {
		// Arrange
		const { gateway, grant } = await packageRun(vi.fn<typeof fetch>())
		const packages = packagesOf(grant)

		// Act
		const opening = await callGateway(gateway, runId, callOf(packages.endpoint, tokenOf(packages), { type: 'open', tools: [] }))

		// Assert
		expect(packages.tokens).toHaveLength(packageTokens)
		expect(packages.tokens.some((token) => grant.tokens.includes(token))).toBe(false)
		expect(errorOf(opening.answer)).toBe('The package endpoint only takes package fetches.')
	})

	test('opens no package endpoint for a run whose app restores from no registry', async () => {
		// Arrange
		const { gateway } = await testGateway()

		// Act
		const grant = await gateway.openRun(runId, { tools: [] }, abortSignal)

		// Assert
		expect(grant.packages).toBeUndefined()
	})
	test('keeps a package it fetched whole, also for a gateway opened later, and fetches it only once', async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('tarball', { headers: { etag: '"1"' } })))
		const { home } = await testGateway()
		const first = await packageRun(sent, 'npm', { home })
		await first.fetchPath('/left-pad/-/left-pad-1.3.0.tgz')
		const later = await packageRun(sent, 'npm', { home })

		// Act
		const { answer, body } = await later.fetchPath('/left-pad/-/left-pad-1.3.0.tgz')

		// Assert
		expect(resultOf(answer)).toMatchObject({ status: 200, headers: { etag: '"1"' } })
		expect(body()?.toString('utf8')).toBe('tarball')
		expect(sent).toHaveBeenCalledOnce()
	})

	test.each([
		['a version list, which changes', '/left-pad', 200],
		['a package that was not found', '/left-pad/-/left-pad-9.9.9.tgz', 404],
	])('fetches %s again each time', async (_what, path, status) => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status })))
		const { fetchPath } = await packageRun(sent)
		await fetchPath(path)

		// Act
		await fetchPath(path)

		// Assert
		expect(sent).toHaveBeenCalledTimes(2)
	})

	test("fetches from a connector's registry where its connector says, with its credential", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })))
		const { fetchPath } = await packageRun(sent, cloudRegistry, { registries: { cloud: cloudResolve } })

		// Act
		const { answer } = await fetchPath('/npm/packages/left-pad', 'application/json')

		// Assert
		expect(resultOf(answer)).toMatchObject({ status: 200 })
		const [url, init] = sent.mock.calls[0] ?? []
		expect(url).toBe('https://packages.cloud.example/npm/packages/left-pad')
		expect(init?.headers).toMatchObject({ authorization: 'Bearer cloud-token', accept: 'application/json' })
	})

	test("takes a connector's registry with its fields in another order as the same one", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')))
		const { gateway } = await testGateway({ fetch: sent, registries: { cloud: cloudResolve } })
		const reordered: ConnectorRegistry = {
			settings: { repository: 'packages' },
			paths: ['/npm/packages/'],
			host: cloudRegistry.host,
			name: cloudRegistry.name,
			connector: 'cloud',
		}
		const grant = await gateway.openRun(runId, { tools: [], registries: [reordered] }, abortSignal)

		// Act
		const { answer } = await callGateway(
			gateway,
			runId,
			callOf(packagesOf(grant).endpoint, tokenOf(packagesOf(grant)), {
				type: 'package',
				request: { registry: cloudRegistry, path: '/npm/packages/left-pad' },
			}),
		)

		// Assert
		expect(resultOf(answer)).toMatchObject({ status: 200 })
	})

	test.each(['/npm/other/left-pad', '/npm/packages/../other/left-pad', '/npm/packages//left-pad', '/pypi/packages/left-pad'])(
		"refuses %s, which isn't on the connector's registry, and asks the connector nothing",
		async (path) => {
			// Arrange
			const sent = vi.fn<typeof fetch>()
			const resolve = vi.fn<ResolveRegistryFetch>()
			const { fetchPath } = await packageRun(sent, cloudRegistry, { registries: { cloud: resolve } })

			// Act
			const { answer } = await fetchPath(path)

			// Assert
			expect(errorOf(answer)).toContain("isn't a package fetch on cloud packages")
			expect(resolve).not.toHaveBeenCalled()
			expect(sent).not.toHaveBeenCalled()
		},
	)

	test("follows a connector registry's redirect to a signed download, without its credential", async () => {
		// Arrange
		const signed = 'https://downloads.cloud.example/left-pad.tgz?signature=abc'
		const sent = vi.fn<typeof fetch>((url) =>
			Promise.resolve(url === signed ? new Response('tarball') : new Response(null, { status: 302, headers: { location: signed } })),
		)
		const { fetchPath } = await packageRun(sent, cloudRegistry, { registries: { cloud: cloudResolve } })

		// Act
		const { answer, body } = await fetchPath('/npm/packages/left-pad/-/left-pad-1.3.0.tgz')

		// Assert
		expect(resultOf(answer)).toMatchObject({ status: 200, headers: {} })
		expect(body()?.toString('utf8')).toBe('tarball')
		expect(sent.mock.calls.map(([url]) => url)).toEqual([
			'https://packages.cloud.example/npm/packages/left-pad/-/left-pad-1.3.0.tgz',
			signed,
		])
		expect(sent.mock.calls[1]?.[1]?.headers).not.toHaveProperty('authorization')
	})

	test.each([
		['to plain HTTP', () => 'http://downloads.cloud.example/left-pad.tgz', 'instead of HTTPS'],
		['in a loop', (url: string) => url, 'more than 3 times'],
	])("refuses a connector registry's redirect %s", async (_what, next, error) => {
		// Arrange
		const sent = vi.fn<typeof fetch>((url) =>
			Promise.resolve(new Response(null, { status: 302, headers: { location: next(url instanceof Request ? url.url : url.toString()) } })),
		)
		const { fetchPath } = await packageRun(sent, cloudRegistry, { registries: { cloud: cloudResolve } })

		// Act
		const { answer } = await fetchPath('/npm/packages/left-pad/-/left-pad-1.3.0.tgz')

		// Assert
		expect(errorOf(answer)).toContain(error)
	})

	test("says which registries' connectors aren't loaded, and fails a fetch on one", async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>()
		const { gateway, fetchPath } = await packageRun(sent, cloudRegistry)

		// Act
		const missing = gateway.missingRegistries(['npm', cloudRegistry])
		const { answer } = await fetchPath('/npm/packages/left-pad')

		// Assert
		expect(missing).toEqual([expect.stringContaining('cloud packages needs connector cloud')])
		expect(errorOf(answer)).toContain("needs connector cloud, which isn't loaded")
		expect(sent).not.toHaveBeenCalled()
	})

	test.each([
		['the connector', 'resolve'],
		['the registry', 'fetch'],
	])('settles a package call promptly when it is stopped, even if %s never answers', async (_who, stuck) => {
		// Arrange
		const sent = vi.fn<typeof fetch>(stuck === 'fetch' ? never : () => Promise.resolve(new Response('{}')))
		const resolve = vi.fn<ResolveRegistryFetch>(stuck === 'resolve' ? never : cloudResolve)
		const { gateway, grant } = await packageRun(sent, cloudRegistry, { registries: { cloud: resolve } })
		const accepted = await gateway.accept(
			runId,
			callOf(packagesOf(grant).endpoint, tokenOf(packagesOf(grant)), {
				type: 'package',
				request: { registry: cloudRegistry, path: '/npm/packages/left-pad' },
			}),
			abortSignal,
		)
		const controller = new AbortController()

		// Act
		const answering = accepted.answer(controller.signal)
		controller.abort(new Error('cancelled'))

		// Assert
		expect((await answering).outcome.ok).toBe(false)
		expect(accepted.body()).toBeUndefined()
	})

	test('passes on the sign-in a connector needs to fetch from its registry', async () => {
		// Arrange
		const resolve = vi.fn<ResolveRegistryFetch>(() => Promise.reject(new SignInNeededError('cloud', 'Sign in to cloud first.')))
		const { fetchPath } = await packageRun(vi.fn<typeof fetch>(), cloudRegistry, { registries: { cloud: resolve } })

		// Act
		const { answer } = await fetchPath('/npm/packages/left-pad')

		// Assert
		expect(answer.outcome).toMatchObject({ ok: false, signInTo: 'cloud' })
	})
})
