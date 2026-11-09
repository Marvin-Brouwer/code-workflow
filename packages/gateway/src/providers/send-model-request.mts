import type { ModelRequest, ModelResponse } from '@mesh-flow/protocol'
import { modelApi } from './model-apis.mts'
import type { ModelChoice } from './resolve-model.mts'

/** The provider's base URL for a model: the user's override, or pi-ai's. */
export function baseUrlOf({ provider, model }: ModelChoice): string {
	return (provider.baseUrl ?? model.baseUrl).replace(/\/+$/, '')
}

/** Headers the sandbox doesn't get to set: credentials, and what `fetch` sets itself. */
const droppedRequestHeaders = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'host', 'content-length', 'connection'])

/** Headers of the provider's answer that don't describe the body the sandbox gets: `fetch` decoded it, and it's whole. */
const droppedResponseHeaders = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'])

/**
 * Sends one model request to its provider with the provider's key and returns the whole response.
 * Refuses a path that isn't a model request of the model's API, and a body for another model, so
 * the key does nothing but this model's calls.
 */
export async function sendModelRequest(
	choice: ModelChoice,
	request: ModelRequest,
	key: string,
	options: { readonly fetch: typeof fetch; readonly abortSignal: AbortSignal },
): Promise<ModelResponse> {
	const api = modelApi(choice.model.api)
	if (api === undefined) throw new Error(`The gateway can't send ${choice.model.api} requests.`)
	const url = new URL(`${baseUrlOf(choice)}${request.path}`)
	const pathBelowBase = url.pathname.slice(new URL(baseUrlOf(choice)).pathname.replace(/\/+$/, '').length)
	if (!api.paths.includes(pathBelowBase)) throw new Error(`${request.path} isn't a model request of ${choice.model.api}.`)
	if (bodyModel(request.body) !== choice.model.id) throw new Error(`The request's body isn't for model ${choice.model.id}.`)

	const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !droppedRequestHeaders.has(name.toLowerCase())))
	const response = await options.fetch(url, {
		method: request.method,
		headers: { ...headers, ...api.credential(key) },
		body: request.body,
		signal: options.abortSignal,
	})
	const body = await response.text()
	const kept: Record<string, string> = {}
	response.headers.forEach((value, name) => {
		if (!droppedResponseHeaders.has(name)) kept[name] = value
	})
	return { status: response.status, headers: kept, body }
}

/** The `model` field of a request body, which every API this sends has. */
function bodyModel(body: string): unknown {
	try {
		const parsed: unknown = JSON.parse(body)
		return typeof parsed === 'object' && parsed !== null && 'model' in parsed ? parsed.model : undefined
	} catch {
		return undefined
	}
}
