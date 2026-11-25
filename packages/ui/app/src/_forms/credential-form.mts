import { choice, component } from '@rooted/components'
import { z } from 'zod'
import { send } from '../_shared/api.mts'
import { CredentialName, credentialPath, NoContent } from '../_shared/settings.mts'
import styles from './forms.css'
import { formStatus, submitActions } from './form-parts.mts'
import { formText } from './form-text.mts'
import { randomSecret } from './random-secret.mts'
import { submitForm } from './submit-form.mts'

/** What the credential form sets, and what it does after. */
export interface CredentialFormOptions {
	/** The credential to set. Without it, the form asks for the name too. */
	readonly name?: string | undefined
	/**
	 * A value of the right shape, such as `https://example.atlassian.net`. A credential with one is a
	 * setting rather than a secret, so its value is shown as it's typed.
	 */
	readonly example?: string | undefined
	/** Called once the credential is set. */
	readonly done?: (() => void) | undefined
}

/**
 * Sets a credential. The value goes in and never comes back. "Generate" fills in a random value,
 * shown once, for a secret the other side takes from here, such as a webhook's.
 */
export const CredentialForm = component<CredentialFormOptions>({
	name: 'credential-form',
	styles,
	onMount({ append, element, options, signal }) {
		const { name, example, done } = options
		const status = formStatus(element)
		const valueType = choice(example === undefined, 'password', 'text')
		const value = element('input', {
			name: 'value',
			type: valueType,
			required: true,
			autocomplete: 'off',
			placeholder: example ?? '',
		})
		const generate = element('button', {
			type: 'button',
			textContent: 'Generate',
			on: {
				click() {
					value.type = 'text'
					value.value = randomSecret()
				},
			},
		})
		append(
			element('form', {
				classes: styles.form,
				children: [
					name === undefined
						? element('label', {
								children: [
									'Name',
									element('input', {
										name: 'name',
										required: true,
										placeholder: 'service/token',
										autocomplete: 'off',
									}),
								],
							})
						: element('p', {
								children: [
									'Credential ',
									element('code', {
										textContent: name,
									}),
								],
							}),
					element('label', {
						children: ['Value', value],
					}),
					submitActions(element, 'Set', generate),
					status,
				],
				on: {
					submit: submitForm({
						status,
						abortSignal: signal,
						send: async (form, abortSignal) => {
							const checked = CredentialName.safeParse(name ?? formText(form, 'name'))
							if (!checked.success) return { ok: false, error: z.prettifyError(checked.error) }
							return send('PUT', credentialPath(checked.data), { value: formText(form, 'value') }, NoContent, abortSignal)
						},
						done() {
							value.type = valueType
							done?.()
						},
					}),
				},
			}),
		)
	},
})
