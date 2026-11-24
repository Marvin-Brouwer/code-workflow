import { component } from '@rooted/components'
import type { ElementFactory } from '@rooted/components/elements'
import { read } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ProviderModelList } from '../_shared/settings.mts'

/** Whose models to show. */
interface ProviderModelsOptions {
	/** The provider's name in the app's config. */
	readonly provider: string
}

/** One model the provider offers, and whether agents can use it. */
function modelItem(element: ElementFactory, model: { readonly id: string; readonly usable: boolean }): HTMLLIElement {
	return element('li', {
		textContent: model.usable ? model.id : `${model.id} (not usable: pi-ai doesn't know it)`,
	})
}

/** What the provider said about its models. */
function modelsView(element: ElementFactory, listed: ProviderModelList): HTMLElement[] {
	if (listed.source === 'failed') return [errorText(element, listed.reason)]
	const note =
		listed.source === 'catalog'
			? [
					element('p', {
						textContent: "This provider has no model list, so these are pi-ai's models of its kind.",
					}),
				]
			: []
	return [
		...note,
		element('ul', {
			children: listed.models.map((model) => modelItem(element, model)),
		}),
	]
}

/**
 * The models a provider with a key offers, asked of the provider itself when opened: the ones
 * agents can use, and the ones they can't.
 */
export const ProviderModels = component<ProviderModelsOptions>({
	name: 'provider-models',
	onMount({ append, element, options, signal }) {
		const { provider } = options
		const body = element('div', {
			textContent: 'Asking the provider...',
		})
		let asked = false
		append(
			element('details', {
				children: [
					element('summary', {
						textContent: 'Models',
					}),
					body,
				],
				on: {
					async toggle(event) {
						if (asked || !(event.currentTarget instanceof HTMLDetailsElement) || !event.currentTarget.open) return
						asked = true
						const answer = await read(`/settings/providers/${encodeURIComponent(provider)}/models`, ProviderModelList, signal)
						body.replaceChildren(...(answer.ok ? modelsView(element, answer.value) : [errorText(element, answer.error)]))
					},
				},
			}),
		)
	},
})
