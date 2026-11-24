import { openAiCompatibleKind, type ModelProviderDescription } from '@mesh-flow/protocol'
import { z } from 'zod'
import { untilAborted } from '../until-aborted.mts'
import type { ServedModels } from './resolve-model.mts'

/** What `GET <baseUrl>/models` answers on a server that speaks OpenAI's API. */
const ModelList = z.object({ data: z.array(z.object({ id: z.string().min(1) })) })

/** Asks a compatible server which models it offers, with its key. Throws when the server can't say. */
function listedModels(
	provider: ModelProviderDescription,
	key: string,
	fetchFromHost: typeof fetch,
	abortSignal: AbortSignal,
): Promise<string[]> {
	// A server that ignores the signal, or never finishes its answer, can't hold up a stop.
	return untilAborted(askedModels(provider, key, fetchFromHost, abortSignal), abortSignal)
}

async function askedModels(
	provider: ModelProviderDescription,
	key: string,
	fetchFromHost: typeof fetch,
	abortSignal: AbortSignal,
): Promise<string[]> {
	const url = `${(provider.baseUrl ?? '').replace(/\/+$/, '')}/models`
	const response = await fetchFromHost(url, { headers: { authorization: `Bearer ${key}` }, signal: abortSignal })
	if (!response.ok) throw new Error(`Provider ${provider.name} didn't list its models: ${url} answered ${response.status}.`)
	const listed = ModelList.safeParse(await response.json())
	if (!listed.success) throw new Error(`Provider ${provider.name} didn't list its models: ${url} answered no model list.`)
	return listed.data.data.map((model) => model.id)
}

/** What {@link servedModels} needs. */
export interface ServedModelsOptions {
	/** The key of a provider, by name, or `undefined` when it has none: a server without a key isn't asked. */
	readonly keyOf: (provider: string) => Promise<string | undefined>
	readonly fetchFromHost: typeof fetch
}

/** The models each compatible server of `providers` that has a key says it offers, asked at once. */
export async function servedModels(
	providers: readonly ModelProviderDescription[],
	{ keyOf, fetchFromHost }: ServedModelsOptions,
	abortSignal: AbortSignal,
): Promise<ServedModels> {
	const compatible = providers.filter((provider) => provider.kind === openAiCompatibleKind)
	const listed = await Promise.all(
		compatible.map(async (provider): Promise<[string, string[]][]> => {
			const key = await keyOf(provider.name)
			if (key === undefined) return []
			return [[provider.name, await listedModels(provider, key, fetchFromHost, abortSignal)]]
		}),
	)
	return new Map(listed.flat())
}
