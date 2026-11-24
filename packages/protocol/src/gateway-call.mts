import { z } from 'zod'
import { ConnectorName } from './connector-name.mts'
import { CompatibleModel, ModelChoice } from './model-provider.mts'
import { PackageRequest } from './package-registry.mts'
import { RequestId } from './request-id.mts'

/** Names a gateway endpoint: the run's own, or one loop's. */
export const EndpointId = z.string().regex(/^[\w-]{1,64}$/)
export type EndpointId = z.infer<typeof EndpointId>

/** The shortest token an endpoint takes, for code that makes tokens of its own, such as a test of the runtime. */
export const minTokenLength = 16

/** The longest token an endpoint takes. */
const maxTokenLength = 128

/** A single-use token for one call on an endpoint. The answer to the call carries the next one. */
export const EndpointToken = z.string().regex(new RegExp(`^[\\w-]{${String(minTokenLength)},${String(maxTokenLength)}}$`))
export type EndpointToken = z.infer<typeof EndpointToken>

/** Names a tool that runs on the host, as a model provider takes tool names. */
export const ToolName = z.string().regex(/^[A-Za-z][\w-]{0,63}$/)
export type ToolName = z.infer<typeof ToolName>

/**
 * A model call, as the provider's SDK made it in the sandbox: the path below the provider's base
 * URL, the headers and the body. The gateway adds the credential and sends it to the provider.
 */
export const ModelRequest = z.object({
	/** The provider, as the app's config names it, that `resolve-model` picked. */
	provider: z.string().min(1),
	/** The model the request is for, as the agent names it. */
	model: z.string().min(1),
	/** The path below the provider's base URL, such as `/v1/messages`. */
	path: z.string().startsWith('/'),
	method: z.literal('POST'),
	headers: z.record(z.string(), z.string()),
	body: z.string(),
})
export type ModelRequest = z.infer<typeof ModelRequest>

/** What the provider answered a model call with: the whole response, also when it was a stream. */
export const ModelResponse = z.object({
	status: z.int(),
	headers: z.record(z.string(), z.string()),
	body: z.string(),
})
export type ModelResponse = z.infer<typeof ModelResponse>

/** Which model runs, on which provider, and the API its SDK speaks. */
export const ResolvedModel = z.object({
	/** The provider as the app's config names it. */
	provider: z.string().min(1),
	/** The pi-ai provider it is, such as `anthropic`, whose SDK makes the request in the sandbox. */
	kind: z.string().min(1),
	model: z.string().min(1),
	/** For a compatible server, which pi-ai doesn't know: its base URL and the model, as the server lists it. */
	compatible: z.object({ baseUrl: z.url(), model: CompatibleModel }).optional(),
})
export type ResolvedModel = z.infer<typeof ResolvedModel>

/**
 * What the runtime asks the gateway for:
 *
 * - `tool`: run a host tool with this input;
 * - `open`: open an endpoint for one loop that takes only these tools. Only on the run's endpoint;
 * - `close`: close a loop's endpoint once the loop has settled. Only on the run's endpoint;
 * - `resolve-model`: which of an agent's models runs, and on which provider: the first model a provider with a key offers, model first;
 * - `model`: send a model request with the provider's credential;
 * - `package`: fetch a package or its metadata from a registry the app restores from. Only on the run's package endpoint, a `RunGrant`'s `packages`.
 */
export const GatewayCall = z.discriminatedUnion('type', [
	z.object({ type: z.literal('tool'), tool: ToolName, input: z.unknown() }),
	z.object({ type: z.literal('open'), tools: z.array(ToolName) }),
	z.object({ type: z.literal('close'), endpoint: EndpointId }),
	z.object({ type: z.literal('resolve-model'), models: ModelChoice }),
	z.object({ type: z.literal('model'), request: ModelRequest }),
	z.object({ type: z.literal('package'), request: PackageRequest }),
])
export type GatewayCall = z.infer<typeof GatewayCall>

/**
 * A call to the gateway, sent as one line of the outbox. The token is spent by sending it: the
 * answer carries the next one, and a token that comes again fails the run.
 */
export const CallMessage = z.object({
	type: z.literal('call'),
	id: RequestId,
	endpoint: EndpointId,
	token: EndpointToken,
	call: GatewayCall,
})
export type CallMessage = z.infer<typeof CallMessage>

/**
 * The runtime doesn't wait for a call, or for a `login` it asked for, any more: the host stops it.
 * A call still answers, with the next token. A `login` isn't answered.
 */
export const CancelMessage = z.object({ type: z.literal('cancel'), id: RequestId })
export type CancelMessage = z.infer<typeof CancelMessage>

/**
 * The answer to a call, in the inbox as the answer's `value`: the result or why there is none,
 * and the token for the endpoint's next call. Without `next`, the endpoint is closed.
 */
export const CallAnswer = z.object({
	next: EndpointToken.optional(),
	outcome: z.discriminatedUnion('ok', [
		z.object({ ok: z.literal(true), result: z.unknown() }),
		z.object({
			ok: z.literal(false),
			error: z.string(),
			/** The failure may pass on another try: the network or the service was down, or the engine stopped mid-call. */
			transient: z.boolean().optional(),
			/**
			 * The call needs a session with this connector's service, and there is none: the user has to
			 * sign in. The tool did nothing, so the runtime asks for a `login` and calls again.
			 */
			signInTo: ConnectorName.optional(),
		}),
	]),
})
export type CallAnswer = z.infer<typeof CallAnswer>

/** An endpoint and its tokens, one per call that may run at the same time. */
export const EndpointGrant = z.object({ endpoint: EndpointId, tokens: z.array(EndpointToken).min(1) })
export type EndpointGrant = z.infer<typeof EndpointGrant>

/**
 * The run's own endpoint, for workflow code, tools and model calls, and, when its app restores
 * packages, an endpoint for package fetches only, with tokens of its own: a restore that fetches
 * many packages at once doesn't hold up the run's other calls.
 */
export const RunGrant = EndpointGrant.extend({ packages: EndpointGrant.optional() })
export type RunGrant = z.infer<typeof RunGrant>
