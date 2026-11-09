import path from 'node:path'
import type { CallAnswer, CallMessage, EndpointGrant, GatewayCall, ModelResponse, ResolvedModel } from '@mesh-flow/protocol'
import type { CredentialStore } from './credentials/credential-store.mts'
import { openRunStates, type EndpointState, type RunState } from './endpoints/run-state.mts'
import { newLoopEndpointId, newToken, tokenHash } from './endpoints/tokens.mts'
import { messageOf } from './errors.mts'
import { ownEntry } from './own-entry.mts'
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

/** Usage is counted also when the call was stopped right after the answer: it was paid for. */
const neverAborted = new AbortController().signal

/** What a provider without a key needs. */
function setKeyHint(provider: string): string {
	return `Set it with \`mesh-flow provider key ${provider}\`.`
}

/** Opens a gateway. Nothing is read until a run calls. */
export function openGateway(options: GatewayOptions): Gateway {
	const states = openRunStates(path.join(options.home, 'runs'))
	const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
	const fetchModel = options.fetch ?? fetch

	const perform = async (runId: string, endpoint: EndpointState, call: GatewayCall, abortSignal: AbortSignal): Promise<unknown> => {
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
				if (state === undefined || ownEntry(state.endpoints, endpoint)?.loop !== true) return { state, value: null }
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
				return [`Provider ${provider.name} serves model ${modelId} but has no API key. ${setKeyHint(provider.name)}`]
			} catch (error) {
				return [messageOf(error)]
			}
		})
	}

	const callModel = async (runId: string, request: Extract<GatewayCall, { type: 'model' }>['request'], abortSignal: AbortSignal) => {
		const choice = chosenModel(await options.providers.list(abortSignal), request.provider, request.model)
		const key = await options.credentials.get(providerCredential(choice.provider.name), abortSignal)
		if (key === undefined) throw new Error(`Provider ${choice.provider.name} has no API key. ${setKeyHint(choice.provider.name)}`)
		const response: ModelResponse = await sendModelRequest(choice, request, key, { fetch: fetchModel, abortSignal })
		const used = usageOf(response.body, choice.model)
		await states.update(
			runId,
			(state) => ({ state: state && { ...state, usage: addUsage(state.usage, choice.model.id, used) }, value: undefined }),
			neverAborted,
		)
		return response
	}

	return Object.freeze<Gateway>({
		openRun: (runId, appTools, abortSignal) =>
			states.update(
				runId,
				(state) => {
					const tokens = newTokens()
					const runTools = [...new Set(appTools)]
					const fresh: RunState = {
						tools: runTools,
						endpoints: { [runEndpoint]: { loop: false, tools: runTools, tokens: tokens.map(tokenHash) } },
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
					const spent = tokenHash(message.token)
					const again = state && ownEntry(state.inFlight, message.id)
					// Read again from where the cursor was saved, after a resume: taken already, maybe run already.
					// Anything else that comes again is someone replaying a call.
					if (again?.interrupted === true && again.endpoint === message.endpoint && again.spent === spent)
						return { state, value: acceptedWith({ next: again.next, outcome: { ok: false, error: interruptedError } }) }
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
									const result = await untilAborted(perform(runId, rotated, message.call, callSignal), callSignal)
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
						value: unanswered.map(([id, call]) => ({ id, answer: { next: call.next, outcome: { ok: false, error: interruptedError } } })),
					}
				},
				abortSignal,
			),
		usage: async (runId, abortSignal) => (await states.load(runId, abortSignal))?.usage ?? {},
		unavailableModels,
		closeRun: (runId, abortSignal) => states.update(runId, (state) => ({ state: undefined, value: state?.usage ?? {} }), abortSignal),
	})
}

function newTokens(): string[] {
	return Array.from({ length: tokensPerEndpoint }, newToken)
}

function acceptedWith(answer: CallAnswer): AcceptedCall {
	return { answer: () => Promise.resolve(answer) }
}
