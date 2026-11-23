import { component } from '@rooted/components'
import { z } from 'zod'
import { read, send } from '../_shared/api.mts'
import { NoContent, ProviderKind } from '../_shared/settings.mts'
import styles from './forms.css'
import { formText } from './form-text.mts'
import { submitForm } from './submit-form.mts'

export interface ProviderFormOptions {
	/** The model it's for, when a run needs it: said above the form, since only the kind knows its models. */
	readonly model?: string
	/** Called once the provider is added. */
	readonly done?: () => void
}

/** Adds a model provider: its name, which kind it is, its key and, for a proxy, its base URL. */
export const ProviderForm = component<ProviderFormOptions>({
	name: 'provider-form',
	styles,
	async onMount({ append, element, options, signal }) {
		const { model, done } = options
		const status = element('p', {
			classes: styles.status,
			role: 'alert',
		})
		const kinds = await read('/settings/provider-kinds', z.array(ProviderKind), signal)
		append(
			element('form', {
				classes: styles.form,
				children: [
					model === undefined
						? undefined
						: element('p', {
								classes: styles.hint,
								children: [
									'Add a provider whose kind offers ',
									element('code', {
										textContent: model,
									}),
									'.',
								],
							}),
					element('label', {
						children: [
							'Name',
							element('input', {
								name: 'name',
								required: true,
								pattern: '[a-z0-9][\\w\\-]{0,63}',
								placeholder: 'anthropic',
								autocomplete: 'off',
							}),
						],
					}),
					element('label', {
						children: [
							'Kind',
							element('select', {
								name: 'kind',
								required: true,
								children: (kinds.ok ? kinds.value : []).map(({ kind, models }) =>
									element('option', {
										value: kind,
										textContent: `${kind} (${String(models)} models)`,
									}),
								),
							}),
						],
					}),
					element('label', {
						children: [
							'API key',
							element('input', {
								name: 'key',
								type: 'password',
								required: true,
								autocomplete: 'off',
							}),
						],
					}),
					element('label', {
						children: [
							'Base URL, for a proxy or a compatible server',
							element('input', {
								name: 'baseUrl',
								type: 'url',
							}),
						],
					}),
					element('div', {
						classes: styles.actions,
						children: element('button', {
							type: 'submit',
							textContent: 'Add',
						}),
					}),
					kinds.ok
						? undefined
						: element('p', {
								role: 'alert',
								textContent: kinds.error,
							}),
					status,
				],
				on: {
					submit: submitForm({
						status,
						abortSignal: signal,
						send: (form, abortSignal) => {
							const baseUrl = formText(form, 'baseUrl')
							const body = { kind: formText(form, 'kind'), key: formText(form, 'key'), ...(baseUrl === '' ? {} : { baseUrl }) }
							return send('PUT', `/settings/providers/${encodeURIComponent(formText(form, 'name'))}`, body, NoContent, abortSignal)
						},
						...(done === undefined ? {} : { done }),
					}),
				},
			}),
		)
	},
})
