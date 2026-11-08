import type { Models } from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'

/**
 * Finds the provider for a model id, model first: the first provider, in the order they were added,
 * that offers the model ([design section 7](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#model-providers)).
 */
export function resolveModel(models: Models, modelId: string): ModelRef {
	for (const provider of models.getProviders()) {
		if (models.getModel(provider.id, modelId) !== undefined) return { provider: provider.id, modelId }
	}
	const offered = models.getModels().map((model) => model.id)
	throw new Error(`No provider of this run offers model ${modelId}. Offered: ${offered.length === 0 ? 'none' : offered.join(', ')}.`)
}
