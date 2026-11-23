import { component } from '@rooted/components'
import { send } from '../_shared/api.mts'
import { NoContent } from '../_shared/settings.mts'
import styles from './forms.css'
import { formStatus, submitActions } from './form-parts.mts'
import { formText } from './form-text.mts'
import { submitForm } from './submit-form.mts'

/** Whose key the form sets, and what it does after. */
export interface ProviderKeyFormOptions {
	/** The provider's name. */
	readonly provider: string
	/** Called once the key is set. */
	readonly done?: (() => void) | undefined
}

/** Sets a provider's API key. It goes in and never comes back. */
export const ProviderKeyForm = component<ProviderKeyFormOptions>({
	name: 'provider-key-form',
	styles,
	onMount({ append, element, options, signal }) {
		const { provider, done } = options
		const status = formStatus(element)
		append(
			element('form', {
				classes: styles.form,
				children: [
					element('label', {
						children: [
							`API key of ${provider}`,
							element('input', {
								name: 'key',
								type: 'password',
								required: true,
								autocomplete: 'off',
							}),
						],
					}),
					submitActions(element, 'Set key'),
					status,
				],
				on: {
					submit: submitForm({
						status,
						abortSignal: signal,
						send: (form, abortSignal) =>
							send(
								'PUT',
								`/settings/providers/${encodeURIComponent(provider)}/key`,
								{ key: formText(form, 'key') },
								NoContent,
								abortSignal,
							),
						done,
					}),
				},
			}),
		)
	},
})
