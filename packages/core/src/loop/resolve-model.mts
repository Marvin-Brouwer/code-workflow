import type { Models } from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'

/**
 * Finds the model an agent runs on, model first: its first model id that a provider offers, on the
 * first provider, in the order they were added, that offers it
 * ([design section 7](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#model-providers)).
 */
export function resolveModel(models: Models, modelIds: readonly string[]): ModelRef {
	for (const modelId of modelIds) {
		const provider = models.getProviders().find((candidate) => models.getModel(candidate.id, modelId) !== undefined)
		if (provider !== undefined) return { provider: provider.id, modelId }
	}
	const offered = models.getModels().map((model) => model.id)
	throw new Error(
		`No provider of this run offers model ${modelIds.join(' or ')}. Offered: ${offered.length === 0 ? 'none' : offered.join(', ')}.`,
	)
}
