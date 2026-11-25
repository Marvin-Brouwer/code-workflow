import { choice, component, optional } from '@rooted/components'
import type { ElementFactory } from '@rooted/components/elements'
import { read } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ProviderModelList, providerPath, type ListedModel } from '../_shared/settings.mts'

/** Whose models to show. */
interface ProviderModelsOptions {
	/** The provider's name in the app's config. */
	readonly provider: string
}

/** One model the provider offers, and whether agents can use it. */
function modelItem(element: ElementFactory, model: ListedModel): HTMLLIElement {
	return element('li', {
		textContent: choice(model.usable, model.id, `${model.id} (not usable: pi-ai doesn't know it)`),
	})
}

/** What the provider said about its models. */
function modelsView(element: ElementFactory, listed: ProviderModelList): HTMLElement {
	if (listed.source === 'failed') return errorText(element, listed.reason)
	return element('div', {
		children: [
			optional(
				listed.source === 'catalog',
				element('p', {
					textContent: "This provider has no model list, so these are pi-ai's models of its kind.",
				}),
			),
			element('ul', {
				children: listed.models.map((model) => modelItem(element, model)),
			}),
		],
	})
}

/**
 * The models a provider with a key offers, asked of the provider itself: the ones agents can use,
 * and the ones they can't.
 */
export const ProviderModels = component<ProviderModelsOptions>({
	name: 'provider-models',
	async onMount({ append, element, options, signal }) {
		const { provider } = options
		const body = element('div', {
			textContent: 'Asking the provider...',
		})
		append(body)
		const answer = await read(`${providerPath(provider)}/models`, ProviderModelList, signal)
		if (signal.aborted) return
		body.replaceChildren(answer.ok ? modelsView(element, answer.value) : errorText(element, answer.error))
	},
})
