import type { Models } from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'
import { resolveModel } from './resolve-model.mts'

/** Where a run's agents get their models: the providers, and which of them serves an agent's model. */
export interface ModelSource {
	readonly models: Models
	/** Which of an agent's model ids runs, and on which provider, model first. May have to ask the gateway. */
	readonly resolve: (modelIds: readonly string[], abortSignal: AbortSignal) => Promise<ModelRef>
}

/** Models a test or an embedding gives directly, resolved in the order the providers were added. */
export function givenModels(models: Models): ModelSource {
	return { models, resolve: (modelIds) => Promise.resolve(resolveModel(models, modelIds)) }
}
