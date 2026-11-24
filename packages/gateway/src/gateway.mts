import path from 'node:path'
import {
	isConnectorRegistry,
	openAiCompatibleKind,
	registryKey,
	stagedFileName,
	uniqueRegistries,
	type CallAnswer,
	type CallMessage,
	type EndpointGrant,
	type GatewayCall,
	type ModelProviderDescription,
	type ModelResponse,
	type PackageRegistry,
	type PackageRequest,
	type PackageResponse,
	type ResolvedModel,
	type RunGrant,
} from '@mesh-flow/protocol'
import type { CredentialStore } from './credentials/credential-store.mts'
import { openRunStates, type EndpointState, type RunState } from './endpoints/run-state.mts'
import { newLoopEndpointId, newToken, tokenHash } from './endpoints/tokens.mts'
import { messageOf } from './errors.mts'
import { ownEntry } from './own-entry.mts'
import type { ResolveRegistryTarget } from './packages/connector-registry.mts'
import { connectorRegistryFetch, fetchFromConnectorRegistry } from './packages/fetch-from-connector-registry.mts'
import { fetchFromPublicRegistry, type RegistryAnswer } from './packages/fetch-from-public-registry.mts'
import { openPackageCache, type PackageCache } from './packages/package-cache.mts'
import { providerCredential } from './providers/provider-credential.mts'
import { chosenModel, notOfferedMessage, offeringProvider, type ModelChoice, type ServedModels } from './providers/resolve-model.mts'
import { servedModels } from './providers/served-models.mts'
import { sendModelRequest } from './providers/send-model-request.mts'
import { addUsage, usageOf, type RunUsage } from './providers/usage.mts'
import type { MissingSetting, SettingFix } from './settings/missing-setting.mts'
import { isTransient, type HostTool } from './tools/host-tool.mts'
import { signInOf } from './tools/sign-in-needed.mts'
import { untilAborted } from './until-aborted.mts'

/** What a gateway runs on. */
export interface GatewayOptions {
	/** The gateway's own directory, for the state of the runs it serves. */
	readonly home: string
	readonly credentials: CredentialStore
	/** The host halves of the tools the app may call. A run gets those its app version lists. */
	readonly tools?: readonly HostTool[]
	/** Sends model requests and package fetches. Default: the global `fetch`. */
	readonly fetch?: typeof fetch
	/** How each connector with registries of its own, such as `aws` for CodeArtifact, reaches them, by connector. Default: none. */
	readonly registries?: Readonly<Record<string, ResolveRegistryTarget>>
	/** Where fetched packages are kept for every run. Default: the `packages` folder in `home`. */
	readonly packageCache?: PackageCache
}

/** What a run may call through the gateway: what its app declares. */
export interface RunAccess {
	/** The host tools its app lists. */
	readonly tools: readonly string[]
	/** The model providers its app declares, in the order a model is looked up. Default: none. */
	readonly providers?: readonly ModelProviderDescription[]
	/** The package registries its app restores from: public ones and connectors'. Default: none. */
	readonly registries?: readonly PackageRegistry[]
}

/** A call the gateway took. Its token is spent, and the answer will carry the next one. */
export interface AcceptedCall {
	/**
	 * Set when the call shows that someone else holds the run's tokens: a token that was used before
	 * or never handed out. Every endpoint of the run is closed by then; fail the run with this.
	 */
	readonly compromised?: string
	/** Runs the call. Never rejects: a failure is the answer's outcome. */
	readonly answer: (abortSignal: AbortSignal) => Promise<GatewayAnswer>
}

/** What a call the gateway ran answers with. */
export interface GatewayAnswer {
	readonly answer: CallAnswer
	/**
	 * The body the answer names, for a call that fetched one, such as a package: write it into the
	 * sandbox where the answer says, before the answer.
	 */
	readonly staged?: Buffer
}

/** What a call did: its result, and the body its answer names, if it fetched one. */
interface Performed {
	readonly result: unknown
	readonly staged?: Buffer
}

/** A call that was taken but not answered when the engine stopped, with the answer it gets now. */
export interface InterruptedCall {
	readonly id: string
	readonly answer: CallAnswer
}

/**
 * The host side of tool calls and model calls
 * ([gateway plan](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/plans/gateway-tool-calls.md)):
 * it holds the credentials and runs everything that needs one, for runs in sandboxes that hold none.
 *
 * Each run gets an endpoint for its workflow code and model calls, each loop one for the tools in
 * its template, and, when its app restores packages, the run a package endpoint. Every call spends a single-use token; the answer carries the next. A token that
 * comes again closes the run's endpoints.
 */
export interface Gateway {
	/**
	 * Opens the run's own endpoint, for the host tools its app lists, and returns its tokens: one per
	 * call that may run at the same time. When the app restores packages, it also opens the run's
	 * package endpoint, which only takes package fetches, with {@link tokensPerPackageEndpoint}
	 * tokens of its own. Opening them again, for a restart, closes the earlier attempt's endpoints.
	 * The run's usage so far stays.
	 */
	readonly openRun: (runId: string, access: RunAccess, abortSignal: AbortSignal) => Promise<RunGrant>
	/**
	 * Takes a call: checks its endpoint and token, spends the token and keeps the call as in flight,
	 * on disk, before it resolves. Save that the call was read only after this, and answer it with
	 * {@link AcceptedCall.answer}.
	 */
	readonly accept: (runId: string, message: CallMessage, abortSignal: AbortSignal) => Promise<AcceptedCall>
	/** Forgets an in-flight call once its answer is in the sandbox. */
	readonly settle: (runId: string, requestId: string, abortSignal: AbortSignal) => Promise<void>
	/**
	 * The calls taken but never answered, as when the engine stopped during them, each with an error
	 * and its next token. Call it when an attempt resumes, before reading the outbox again, and
	 * {@link settle} each once its answer is in. Until then a resume lists it again. A call read
	 * again from where the cursor was saved gets the same answer.
	 */
	readonly interrupted: (runId: string, abortSignal: AbortSignal) => Promise<InterruptedCall[]>
	/** Forgets the interrupted calls that were answered, once the outbox was read past them after a resume. */
	readonly forgetInterrupted: (runId: string, abortSignal: AbortSignal) => Promise<void>
	/** What the run used of each model so far. */
	readonly usage: (runId: string, abortSignal: AbortSignal) => Promise<RunUsage>
	/**
	 * Why each agent's models, of `agentModels`, can't run now on `providers`: none of them is
	 * offered by a provider with a key. Empty when every agent can run. A trigger checks the app's
	 * models with it before it makes a sandbox.
	 */
	readonly unavailableModels: (
		providers: readonly ModelProviderDescription[],
		agentModels: readonly (readonly string[])[],
		abortSignal: AbortSignal,
	) => Promise<MissingSetting[]>
	/** Which of `tools` this gateway has no host tool for. A trigger checks the app's tools with it before it makes a sandbox. */
	readonly missingTools: (tools: readonly string[]) => string[]
	/** Why each of `registries` can't be restored from: its connector isn't loaded. A trigger checks the app's registries with it. */
	readonly missingRegistries: (registries: readonly PackageRegistry[]) => MissingSetting[]
	/** Closes every endpoint of the run and forgets it. Resolves to what the run used. */
	readonly closeRun: (runId: string, abortSignal: AbortSignal) => Promise<RunUsage>
}

/** How many calls on one endpoint may run at the same time: the tokens it hands out at once. */
export const tokensPerEndpoint = 4

/**
 * How many package fetches may run at the same time, on the run's package endpoint. A restore
 * fetches many small files; npm and NuGet each fetch several at once.
 */
export const tokensPerPackageEndpoint = 8

/** The id of a run's own endpoint. */
const runEndpoint = 'run'

/** The id of a run's package endpoint. */
const packageEndpoint = 'packages'

/** The answer to a call that came again after an engine restart: it may or may not have run. */
const interruptedError = 'The engine stopped while this call ran, so whether it took effect is unknown.'

/** Usage is counted also when the call was stopped right after the answer: it was paid for. */
const neverAborted = new AbortController().signal

/** What a provider without a key needs. */
function setKeyHint(provider: string): string {
	return `Set it with \`mesh-flow provider key ${provider}\`.`
}

/**
 * Says why none of an agent's models can run, when no provider with a key offers one: the first
 * provider that offers one has no key, or no provider in the config offers any.
 */
function unavailableMessage(providers: readonly ModelProviderDescription[], modelIds: readonly string[], served: ServedModels): string {
	const keyless = offeringProvider(providers, modelIds, () => true, served)
	if (keyless === undefined) return modelIds.map((modelId) => notOfferedMessage(providers, modelId)).join(' ')
	return `Provider ${keyless.provider.name} offers model ${keyless.model.id} but has no API key. ${setKeyHint(keyless.provider.name)}`
}

/** A model choice as the sandbox gets it: for a compatible server, which pi-ai doesn't know, with the model described. */
function resolvedModel({ provider, model }: ModelChoice): ResolvedModel {
	const resolved: ResolvedModel = { provider: provider.name, kind: provider.kind, model: model.id }
	if (provider.kind !== openAiCompatibleKind || provider.baseUrl === undefined) return resolved
	const { id, contextWindow, maxTokens, reasoning } = model
	return { ...resolved, compatible: { baseUrl: provider.baseUrl, model: { id, contextWindow, maxTokens, reasoning } } }
}

/** What a call that failed answers: why, and whether another try, or a sign-in first, may help. */
function failedOutcome(error: unknown): CallAnswer['outcome'] {
	const signInTo = signInOf(error)
	return {
		ok: false,
		error: messageOf(error),
		...(isTransient(error) ? { transient: true } : {}),
		...(signInTo === undefined ? {} : { signInTo }),
	}
}

/** Opens a gateway. Nothing is read until a run calls. */
export function openGateway(options: GatewayOptions): Gateway {
	const states = openRunStates(path.join(options.home, 'runs'))
	const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
	const fetchFromHost = options.fetch ?? fetch
	const connectorRegistries = options.registries ?? {}
	const cache = options.packageCache ?? openPackageCache(path.join(options.home, 'packages'))

	/** Fetches a package from the cache, or from its registry, and keeps it in the cache when it's one that never changes. */
	const fetchedPackage = async (request: PackageRequest, abortSignal: AbortSignal): Promise<RegistryAnswer> => {
		const { registry } = request
		const connectorFetch = isConnectorRegistry(registry) ? connectorRegistryFetch({ ...request, registry }, connectorRegistries) : undefined
		const cached = await cache.get(request, abortSignal)
		if (cached !== undefined) return cached
		const fetched =
			connectorFetch === undefined
				? await fetchFromPublicRegistry(request, { fetchFromHost }, abortSignal)
				: await fetchFromConnectorRegistry(
						request,
						await connectorFetch.resolve(connectorFetch.request, abortSignal),
						{ fetchFromHost },
						abortSignal,
					)
		await cache.put(request, fetched, abortSignal)
		return fetched
	}

	const perform = async (
		runId: string,
		state: RunState,
		endpoint: EndpointState,
		message: CallMessage,
		abortSignal: AbortSignal,
	): Promise<Performed> => {
		const { call } = message
		if (call.type === 'tool') {
			if (!endpoint.tools.includes(call.tool)) throw new Error(`${call.tool} isn't one of the tools of this endpoint.`)
			const tool = tools.get(call.tool)
			if (tool === undefined) throw new Error(`This gateway has no host tool ${call.tool}.`)
			return { result: await tool.run(call.input, { abortSignal, credentials: options.credentials, runId }) }
		}
		if (endpoint.packages !== (call.type === 'package'))
			throw new Error(
				endpoint.packages ? 'The package endpoint only takes package fetches.' : 'Package fetches go on the package endpoint.',
			)
		if (endpoint.loop) throw new Error(`A loop's endpoint only takes its tools, not a ${call.type} call.`)
		if (call.type === 'open') return { result: await openLoop(runId, call.tools, abortSignal) }
		if (call.type === 'close') return { result: await closeLoop(runId, call.endpoint, abortSignal) }
		if (call.type === 'resolve-model') {
			const served = await servedModelsOf(state.providers, abortSignal)
			const choice = offeringProvider(state.providers, call.models, await keyCheck(abortSignal), served)
			if (choice === undefined) throw new Error(unavailableMessage(state.providers, call.models, served))
			return { result: resolvedModel(choice) }
		}
		if (call.type === 'package') {
			const asked = registryKey(call.request.registry)
			// The registry as the app listed it, never as the sandbox describes it.
			const registry = state.registries.find((listed) => registryKey(listed) === asked)
			if (registry === undefined)
				throw new Error(`The app doesn't restore from ${call.request.registry.name}: add it to the sandbox's registries.`)
			const fetched = await fetchedPackage({ ...call.request, registry }, abortSignal)
			const result: PackageResponse = {
				status: fetched.status,
				headers: fetched.headers,
				body: stagedFileName(message.id),
				size: fetched.body.length,
			}
			return { result, staged: fetched.body }
		}
		return { result: await callModel(runId, state.providers, call.request, abortSignal) }
	}

	const openLoop = (runId: string, loopTools: readonly string[], abortSignal: AbortSignal) =>
		states.update(
			runId,
			(state) => {
				if (state === undefined) throw new Error(`Run ${runId} has no endpoints.`)
				const unknown = loopTools.filter((name) => !state.tools.includes(name))
				if (unknown.length > 0) throw new Error(`The app doesn't list ${unknown.join(', ')}, so no loop can call them.`)
				const endpoint = newLoopEndpointId()
				const tokens = newTokens()
				const opened: EndpointState = { loop: true, packages: false, tools: [...new Set(loopTools)], tokens: tokens.map(tokenHash) }
				return {
					state: { ...state, endpoints: { ...state.endpoints, [endpoint]: opened } },
					value: { endpoint, tokens } satisfies EndpointGrant,
				}
			},
			abortSignal,
		)

	const closeLoop = (runId: string, endpoint: string, abortSignal: AbortSignal) =>
		states.update(
			runId,
			(state) => {
				if (state === undefined || ownEntry(state.endpoints, endpoint)?.loop !== true) return { state, value: null }
				const { [endpoint]: _closed, ...open } = state.endpoints
				return { state: { ...state, endpoints: open }, value: null }
			},
			abortSignal,
		)

	/** The models the app's compatible servers with a key offer now, each asked with its key. */
	const servedModelsOf = (providers: readonly ModelProviderDescription[], abortSignal: AbortSignal) =>
		servedModels(
			providers,
			{ keyOf: (provider) => options.credentials.get(providerCredential(provider), abortSignal), fetchFromHost },
			abortSignal,
		)

	/** Whether a provider, by name, has a key now. */
	const keyCheck = async (abortSignal: AbortSignal): Promise<(provider: string) => boolean> => {
		const names = new Set(await options.credentials.names(abortSignal))
		return (provider) => names.has(providerCredential(provider))
	}

	const unavailableModels = async (
		providers: readonly ModelProviderDescription[],
		agentModels: readonly (readonly string[])[],
		abortSignal: AbortSignal,
	) => {
		const hasKey = await keyCheck(abortSignal)
		// A server that can't list its models now counts as offering them: the loop that needs one says why it can't.
		const served = await servedModelsOf(providers, abortSignal).catch((): ServedModels => {
			abortSignal.throwIfAborted()
			return new Map()
		})
		const missing = agentModels.flatMap((modelIds): MissingSetting[] => {
			if (offeringProvider(providers, modelIds, hasKey, served) !== undefined) return []
			const keyless = offeringProvider(providers, modelIds, () => true, served)
			const fix: SettingFix = keyless === undefined ? { kind: 'other' } : { kind: 'provider-key', provider: keyless.provider.name }
			return [{ message: unavailableMessage(providers, modelIds, served), fix }]
		})
		// Two agents that need the same key say so once.
		return [...new Map(missing.map((setting) => [setting.message, setting])).values()]
	}

	const callModel = async (
		runId: string,
		providers: readonly ModelProviderDescription[],
		request: Extract<GatewayCall, { type: 'model' }>['request'],
		abortSignal: AbortSignal,
	) => {
		const choice = chosenModel(providers, request.provider, request.model)
		const key = await options.credentials.get(providerCredential(choice.provider.name), abortSignal)
		if (key === undefined) throw new Error(`Provider ${choice.provider.name} has no API key. ${setKeyHint(choice.provider.name)}`)
		const response: ModelResponse = await sendModelRequest(choice, request, key, { fetch: fetchFromHost, abortSignal })
		const used = usageOf(response.body, choice.model)
		await states.update(
			runId,
			(state) => ({ state: state && { ...state, usage: addUsage(state.usage, choice.model.id, used) }, value: undefined }),
			neverAborted,
		)
		return response
	}

	const missingTools = (appTools: readonly string[]) => [...new Set(appTools)].filter((name) => !tools.has(name))
	const missingRegistries = (registries: readonly PackageRegistry[]) =>
		registries.flatMap((registry): MissingSetting[] =>
			!isConnectorRegistry(registry) || ownEntry(connectorRegistries, registry.connector) !== undefined
				? []
				: [
						{
							message: `${registry.name} needs connector ${registry.connector}: add it with \`mesh-flow connector add\`.`,
							fix: { kind: 'connector', connector: registry.connector },
						},
					],
		)

	return Object.freeze<Gateway>({
		missingTools,
		missingRegistries,
		openRun: (runId, access, abortSignal) =>
			states.update(
				runId,
				(state) => {
					const tokens = newTokens()
					const runTools = [...new Set(access.tools)]
					const registries = uniqueRegistries(access.registries ?? [])
					const packageEndpointTokens = registries.length === 0 ? [] : newTokens(tokensPerPackageEndpoint)
					const fresh: RunState = {
						tools: runTools,
						registries,
						providers: [...(access.providers ?? [])],
						endpoints: {
							[runEndpoint]: { loop: false, packages: false, tools: runTools, tokens: tokens.map(tokenHash) },
							...(packageEndpointTokens.length === 0
								? {}
								: { [packageEndpoint]: { loop: false, packages: true, tools: [], tokens: packageEndpointTokens.map(tokenHash) } }),
						},
						inFlight: {},
						usage: state?.usage ?? {},
					}
					return {
						state: fresh,
						value: {
							endpoint: runEndpoint,
							tokens,
							...(packageEndpointTokens.length === 0 ? {} : { packages: { endpoint: packageEndpoint, tokens: packageEndpointTokens } }),
						},
					}
				},
				abortSignal,
			),
		accept: (runId, message, abortSignal) =>
			states.update(
				runId,
				(state): { state: RunState | undefined; value: AcceptedCall } => {
					const spent = tokenHash(message.token)
					const again = state && ownEntry(state.inFlight, message.id)
					// Read again from where the cursor was saved, after a resume: taken already, maybe run already.
					// Anything else that comes again is someone replaying a call.
					if (again?.interrupted === true && again.endpoint === message.endpoint && again.spent === spent)
						return { state, value: acceptedWith({ next: again.next, outcome: { ok: false, error: interruptedError, transient: true } }) }
					const endpoint = state && ownEntry(state.endpoints, message.endpoint)
					if (state === undefined || endpoint === undefined || again !== undefined || !endpoint.tokens.includes(spent)) {
						const reason =
							state?.revoked ??
							(endpoint === undefined
								? `A call came for endpoint ${message.endpoint}, which run ${runId} doesn't have open.`
								: `A token was used on endpoint ${message.endpoint} of run ${runId} that isn't good: used before, or never handed out. Someone else has the run's tokens.`)
						const closed = state && { ...state, endpoints: {}, revoked: reason }
						return { state: closed, value: { compromised: reason, ...acceptedWith({ outcome: { ok: false, error: reason } }) } }
					}
					const next = newToken()
					const rotated: EndpointState = { ...endpoint, tokens: [...endpoint.tokens.filter((hash) => hash !== spent), tokenHash(next)] }
					return {
						state: {
							...state,
							endpoints: { ...state.endpoints, [message.endpoint]: rotated },
							inFlight: {
								...state.inFlight,
								[message.id]: { endpoint: message.endpoint, spent, next, interrupted: false, answered: false },
							},
						},
						value: {
							answer: async (callSignal) => {
								try {
									// A tool that ignores its signal can't hold up a stop.
									const { result, staged } = await untilAborted(perform(runId, state, rotated, message, callSignal), callSignal)
									const answer: CallAnswer = { next, outcome: { ok: true, result: result ?? null } }
									return staged === undefined ? { answer } : { answer, staged }
								} catch (error) {
									return {
										answer: {
											next,
											outcome: callSignal.aborted
												? { ok: false, error: `The call was stopped: ${messageOf(callSignal.reason)}` }
												: failedOutcome(error),
										},
									}
								}
							},
						},
					}
				},
				abortSignal,
			),
		settle: (runId, requestId, abortSignal) =>
			states.update(
				runId,
				(state) => {
					const call = state && ownEntry(state.inFlight, requestId)
					if (state === undefined || call === undefined) return { state, value: undefined }
					const { [requestId]: _settled, ...rest } = state.inFlight
					// An interrupted call may still be read again, until the outbox is read past it.
					const inFlight = call.interrupted ? { ...state.inFlight, [requestId]: { ...call, answered: true } } : rest
					return { state: { ...state, inFlight }, value: undefined }
				},
				abortSignal,
			),
		forgetInterrupted: (runId, abortSignal) =>
			states.update(
				runId,
				(state) => {
					if (state === undefined) return { state, value: undefined }
					const inFlight = Object.fromEntries(Object.entries(state.inFlight).filter(([, call]) => !(call.interrupted && call.answered)))
					return { state: { ...state, inFlight }, value: undefined }
				},
				abortSignal,
			),
		interrupted: (runId, abortSignal) =>
			states.update(
				runId,
				(state) => {
					if (state === undefined) return { state, value: [] }
					const calls = Object.entries(state.inFlight)
					const unanswered = calls.filter(([, call]) => !call.answered)
					const marked = Object.fromEntries(calls.map(([id, call]) => [id, { ...call, interrupted: true }]))
					return {
						state: { ...state, inFlight: marked },
						value: unanswered.map(([id, call]) => ({
							id,
							answer: { next: call.next, outcome: { ok: false, error: interruptedError, transient: true } },
						})),
					}
				},
				abortSignal,
			),
		usage: async (runId, abortSignal) => (await states.load(runId, abortSignal))?.usage ?? {},
		unavailableModels,
		closeRun: (runId, abortSignal) => states.update(runId, (state) => ({ state: undefined, value: state?.usage ?? {} }), abortSignal),
	})
}

function newTokens(count = tokensPerEndpoint): string[] {
	return Array.from({ length: count }, newToken)
}

function acceptedWith(answer: CallAnswer): AcceptedCall {
	return { answer: () => Promise.resolve({ answer }) }
}
