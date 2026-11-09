import path from 'node:path'
import type { CallAnswer, CallMessage, EndpointGrant, GatewayCall, ModelResponse, ResolvedModel } from '@mesh-flow/protocol'
import type { CredentialStore } from './credentials/credential-store.mts'
import { openRunStates, type EndpointState, type RunState } from './endpoints/run-state.mts'
import { newLoopEndpointId, newToken, tokenHash } from './endpoints/tokens.mts'
import { messageOf } from './errors.mts'
import { providerCredential, type ProviderSettings } from './providers/provider-settings.mts'
import { chosenModel, resolveModel } from './providers/resolve-model.mts'
import { sendModelRequest } from './providers/send-model-request.mts'
import { addUsage, usageOf, type RunUsage } from './providers/usage.mts'
import type { HostTool } from './tools/host-tool.mts'
import { untilAborted } from './until-aborted.mts'

/** What a gateway runs on. */
export interface GatewayOptions {
	/** The gateway's own directory, for the state of the runs it serves. */
	readonly home: string
	readonly credentials: CredentialStore
	readonly providers: ProviderSettings
	/** The host halves of the tools apps may call. A run gets those of them its app lists. */
	readonly tools?: readonly HostTool[]
	/** Sends model requests. Default: the global `fetch`. */
	readonly fetch?: typeof fetch
}

/** A call the gateway took. Its token is spent, and the answer will carry the next one. */
export interface AcceptedCall {
	/**
	 * Set when the call shows that someone else holds the run's tokens: a token that was used before
	 * or never handed out. Every endpoint of the run is closed by then; fail the run with this.
	 */
	readonly compromised?: string
	/** Runs the call. Never rejects: a failure is the answer's outcome. */
	readonly answer: (abortSignal: AbortSignal) => Promise<CallAnswer>
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
 * Each run gets an endpoint for its workflow code and model calls, and each loop one for the tools
 * in its template. Every call spends a single-use token; the answer carries the next. A token that
 * comes again closes the run's endpoints.
 */
export interface Gateway {
	/**
	 * Opens the run's own endpoint, for the host tools its app lists, and returns its tokens: one per
	 * call that may run at the same time. Opening it again, for a restart, closes the earlier
	 * attempt's endpoints. The run's usage so far stays.
	 */
	readonly openRun: (runId: string, tools: readonly string[], abortSignal: AbortSignal) => Promise<EndpointGrant>
	/**
	 * Takes a call: checks its endpoint and token, spends the token and keeps the call as in flight,
	 * on disk, before it resolves. Save that the call was read only after this, and answer it with
	 * {@link AcceptedCall.answer}.
	 */
	readonly accept: (runId: string, message: CallMessage, abortSignal: AbortSignal) => Promise<AcceptedCall>
	/** Forgets an in-flight call once its answer is in the sandbox. */
	readonly settle: (runId: string, requestId: string, abortSignal: AbortSignal) => Promise<void>
	/** The calls taken but never answered, as when the engine stopped during them, each with an error and its next token. */
	readonly interrupted: (runId: string, abortSignal: AbortSignal) => Promise<InterruptedCall[]>
	/** What the run used of each model so far. */
	readonly usage: (runId: string, abortSignal: AbortSignal) => Promise<RunUsage>
	/**
	 * Why each of `models` can't run now: no provider offers it, or the one that does has no key.
	 * Empty when all can. A trigger checks the app's models with it before it makes a sandbox.
	 */
	readonly unavailableModels: (models: readonly string[], abortSignal: AbortSignal) => Promise<string[]>
	/** Closes every endpoint of the run and forgets it. Resolves to what the run used. */
	readonly closeRun: (runId: string, abortSignal: AbortSignal) => Promise<RunUsage>
}

/** How many calls on one endpoint may run at the same time: the tokens it hands out at once. */
export const tokensPerEndpoint = 4

/** The id of a run's own endpoint. */
const runEndpoint = 'run'

/** The answer to a call that came again after an engine restart: it may or may not have run. */
const interruptedError = 'The engine stopped while this call ran, so whether it took effect is unknown.'

/** Opens a gateway. Nothing is read until a run calls. */
export function openGateway(options: GatewayOptions): Gateway {
	const states = openRunStates(path.join(options.home, 'runs'))
	const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
	const fetchModel = options.fetch ?? fetch

	const run = async (runId: string, endpoint: EndpointState, call: GatewayCall, abortSignal: AbortSignal): Promise<unknown> => {
		if (call.type === 'tool') {
			if (!endpoint.tools.includes(call.tool)) throw new Error(`${call.tool} isn't one of the tools of this endpoint.`)
			const tool = tools.get(call.tool)
			if (tool === undefined) throw new Error(`This gateway has no host tool ${call.tool}.`)
			return tool.run(call.input, { abortSignal, credentials: options.credentials, runId })
		}
		if (endpoint.loop) throw new Error(`A loop's endpoint only takes its tools, not a ${call.type} call.`)
		if (call.type === 'open') return openLoop(runId, call.tools, abortSignal)
		if (call.type === 'close') return closeLoop(runId, call.endpoint, abortSignal)
		if (call.type === 'resolve-model') {
			const { provider, model } = resolveModel(await options.providers.list(abortSignal), call.model)
			return { provider: provider.name, kind: provider.kind, model: model.id } satisfies ResolvedModel
		}
		return callModel(runId, call.request, abortSignal)
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
				const opened: EndpointState = { loop: true, tools: [...new Set(loopTools)], tokens: tokens.map(tokenHash) }
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
				if (state?.endpoints[endpoint]?.loop !== true) return { state, value: null }
				const { [endpoint]: _closed, ...open } = state.endpoints
				return { state: { ...state, endpoints: open }, value: null }
			},
			abortSignal,
		)

	const unavailableModels = async (models: readonly string[], abortSignal: AbortSignal) => {
		const providers = await options.providers.list(abortSignal)
		const keys = new Set(await options.credentials.names(abortSignal))
		return [...new Set(models)].flatMap((modelId) => {
			try {
				const { provider } = resolveModel(providers, modelId)
				if (keys.has(providerCredential(provider.name))) return []
				return [
					`Provider ${provider.name} serves model ${modelId} but has no API key. Set it with \`mesh-flow provider key ${provider.name}\`.`,
				]
			} catch (error) {
				return [messageOf(error)]
			}
		})
	}

	const callModel = async (runId: string, request: Extract<GatewayCall, { type: 'model' }>['request'], abortSignal: AbortSignal) => {
		const choice = chosenModel(await options.providers.list(abortSignal), request.provider, request.model)
		const key = await options.credentials.get(providerCredential(choice.provider.name), abortSignal)
		if (key === undefined)
			throw new Error(`Provider ${choice.provider.name} has no API key. Set it with \`mesh-flow provider key ${choice.provider.name}\`.`)
		const response: ModelResponse = await sendModelRequest(choice, request, key, { fetch: fetchModel, abortSignal })
		const used = usageOf(response.body, choice.model)
		await states.update(
			runId,
			(state) => ({ state: state && { ...state, usage: addUsage(state.usage, choice.model.id, used) }, value: undefined }),
			// Counted also when the call was stopped right after the answer: it was paid for.
			new AbortController().signal,
		)
		return response
	}

	return Object.freeze<Gateway>({
		openRun: (runId, appTools, abortSignal) =>
			states.update(
				runId,
				(state) => {
					const tokens = newTokens()
					const fresh: RunState = {
						tools: [...new Set(appTools)],
						endpoints: { [runEndpoint]: { loop: false, tools: [...new Set(appTools)], tokens: tokens.map(tokenHash) } },
						inFlight: {},
						usage: state?.usage ?? {},
					}
					return { state: fresh, value: { endpoint: runEndpoint, tokens } }
				},
				abortSignal,
			),
		accept: (runId, message, abortSignal) =>
			states.update(
				runId,
				(state): { state: RunState | undefined; value: AcceptedCall } => {
					const again = state?.inFlight[message.id]
					// Read again after an engine restart: it was taken already, maybe run already.
					if (again !== undefined) return { state, value: answered({ next: again.next, outcome: { ok: false, error: interruptedError } }) }
					const endpoint = state?.endpoints[message.endpoint]
					if (state === undefined || endpoint === undefined || !endpoint.tokens.includes(tokenHash(message.token))) {
						const reason =
							state?.revoked ??
							(endpoint === undefined
								? `A call came for endpoint ${message.endpoint}, which run ${runId} doesn't have open.`
								: `A token was used on endpoint ${message.endpoint} of run ${runId} that isn't good: used before, or never handed out. Someone else has the run's tokens.`)
						const closed = state && { ...state, endpoints: {}, revoked: reason }
						return { state: closed, value: { compromised: reason, ...answered({ outcome: { ok: false, error: reason } }) } }
					}
					const next = newToken()
					const spent = tokenHash(message.token)
					const rotated: EndpointState = { ...endpoint, tokens: [...endpoint.tokens.filter((hash) => hash !== spent), tokenHash(next)] }
					return {
						state: {
							...state,
							endpoints: { ...state.endpoints, [message.endpoint]: rotated },
							inFlight: { ...state.inFlight, [message.id]: { endpoint: message.endpoint, next } },
						},
						value: {
							answer: async (callSignal) => {
								try {
									// A tool that ignores its signal can't hold up a stop.
									const result = await untilAborted(run(runId, rotated, message.call, callSignal), callSignal)
									return { next, outcome: { ok: true, result: result ?? null } }
								} catch (error) {
									return {
										next,
										outcome: {
											ok: false,
											error: callSignal.aborted ? `The call was stopped: ${messageOf(callSignal.reason)}` : messageOf(error),
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
					if (state === undefined) return { state, value: undefined }
					const { [requestId]: _settled, ...rest } = state.inFlight
					return { state: { ...state, inFlight: rest }, value: undefined }
				},
				abortSignal,
			),
		async interrupted(runId, abortSignal) {
			const state = await states.load(runId, abortSignal)
			return Object.entries(state?.inFlight ?? {}).map(([id, call]) => ({
				id,
				answer: { next: call.next, outcome: { ok: false, error: interruptedError } },
			}))
		},
		usage: async (runId, abortSignal) => (await states.load(runId, abortSignal))?.usage ?? {},
		unavailableModels,
		closeRun: (runId, abortSignal) => states.update(runId, (state) => ({ state: undefined, value: state?.usage ?? {} }), abortSignal),
	})
}

function newTokens(): string[] {
	return Array.from({ length: tokensPerEndpoint }, newToken)
}

function answered(answer: CallAnswer): AcceptedCall {
	return { answer: () => Promise.resolve(answer) }
}
