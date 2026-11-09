import type { Models } from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'
import { resolveModel } from './resolve-model.mts'

/** Where a run's agents get their models: the providers, and which of them serves a model id. */
export interface ModelSource {
	readonly models: Models
	/** Which provider serves a model id, model first. May have to ask the gateway. */
	readonly resolve: (modelId: string, abortSignal: AbortSignal) => Promise<ModelRef>
}

/** Models a test or an embedding gives directly, resolved in the order the providers were added. */
export function givenModels(models: Models): ModelSource {
	return { models, resolve: (modelId) => Promise.resolve(resolveModel(models, modelId)) }
}
