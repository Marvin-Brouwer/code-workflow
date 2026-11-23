import { choice, component } from '@rooted/components'
import { send } from '../_shared/api.mts'
import { credentialPath, NoContent } from '../_shared/settings.mts'
import styles from './forms.css'
import { formText } from './form-text.mts'
import { submitForm } from './submit-form.mts'

export interface CredentialFormOptions {
	/** The credential to set. Without it, the form asks for the name too. */
	readonly name?: string
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
		const status = element('p', {
			classes: styles.status,
			role: 'alert',
		})
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
					element('div', {
						classes: styles.actions,
						children: [
							element('button', {
								type: 'submit',
								textContent: 'Set',
							}),
							generate,
						],
					}),
					status,
				],
				on: {
					submit: submitForm({
						status,
						abortSignal: signal,
						send: (form, abortSignal) =>
							send('PUT', credentialPath(name ?? formText(form, 'name')), { value: formText(form, 'value') }, NoContent, abortSignal),
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

/** 32 random bytes as hex: a webhook secret or anything else nobody has to type. */
function randomSecret(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
