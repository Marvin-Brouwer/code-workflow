import { z } from 'zod'
import { RequestId } from './request-id.mts'

/** Names a gateway endpoint: the run's own, or one loop's. */
export const EndpointId = z.string().regex(/^[\w-]{1,64}$/)
export type EndpointId = z.infer<typeof EndpointId>

/** A single-use token for one call on an endpoint. The answer to the call carries the next one. */
export const EndpointToken = z.string().regex(/^[\w-]{16,128}$/)
export type EndpointToken = z.infer<typeof EndpointToken>

/** Names a tool that runs on the host, as a model provider takes tool names. */
export const ToolName = z.string().regex(/^[A-Za-z][\w-]{0,63}$/)
export type ToolName = z.infer<typeof ToolName>

/**
 * A model call, as the provider's SDK made it in the sandbox: the path below the provider's base
 * URL, the headers and the body. The gateway adds the credential and sends it to the provider.
 */
export const ModelRequest = z.object({
	/** The provider, as the user named it, that `resolve-model` picked. */
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

/** Which provider serves a model, model first, and the API its SDK speaks. */
export const ResolvedModel = z.object({
	/** The provider as the user named it. */
	provider: z.string().min(1),
	/** The pi-ai provider it is, such as `anthropic`, whose SDK makes the request in the sandbox. */
	kind: z.string().min(1),
	model: z.string().min(1),
})
export type ResolvedModel = z.infer<typeof ResolvedModel>

/**
 * What the runtime asks the gateway for:
 *
 * - `tool`: run a host tool with this input;
 * - `open`: open an endpoint for one loop that takes only these tools. Only on the run's endpoint;
 * - `close`: close a loop's endpoint once the loop has settled. Only on the run's endpoint;
 * - `resolve-model`: which provider serves a model, model first;
 * - `model`: send a model request with the provider's credential.
 */
export const GatewayCall = z.discriminatedUnion('type', [
	z.object({ type: z.literal('tool'), tool: ToolName, input: z.unknown() }),
	z.object({ type: z.literal('open'), tools: z.array(ToolName) }),
	z.object({ type: z.literal('close'), endpoint: EndpointId }),
	z.object({ type: z.literal('resolve-model'), model: z.string().min(1) }),
	z.object({ type: z.literal('model'), request: ModelRequest }),
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

/** The runtime doesn't wait for a call any more: the host stops it. It still answers, with the next token. */
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
		}),
	]),
})
export type CallAnswer = z.infer<typeof CallAnswer>

/** An endpoint and its tokens, one per call that may run at the same time. */
export const EndpointGrant = z.object({ endpoint: EndpointId, tokens: z.array(EndpointToken).min(1) })
export type EndpointGrant = z.infer<typeof EndpointGrant>
