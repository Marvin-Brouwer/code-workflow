import { component, optional } from '@rooted/components'
import { send } from '../_shared/api.mts'
import { credentialPath, NoContent } from '../_shared/settings.mts'
import styles from './forms.css'
import { formStatus } from './form-parts.mts'
import { formText } from './form-text.mts'
import { randomSecret } from './random-secret.mts'
import { submitForm } from './submit-form.mts'

/** Which credential the form replaces, and what it does after. */
export interface ReplaceCredentialFormOptions {
	/** The credential to replace. */
	readonly name: string
	/** Called once the credential is replaced or cleared. */
	readonly done?: (() => void) | undefined
}

/**
 * One line to replace a credential's value or clear it, without opening anything first. The new
 * value goes in and never comes back. A webhook secret can be generated, shown once, to copy into
 * the webhook's settings on the other side.
 */
export const ReplaceCredentialForm = component<ReplaceCredentialFormOptions>({
	name: 'replace-credential-form',
	styles,
	onMount({ append, element, options, signal }) {
		const { name, done } = options
		const status = formStatus(element)
		const value = element('input', {
			name: 'value',
			type: 'password',
			required: true,
			autocomplete: 'off',
			placeholder: 'New value',
			ariaLabel: `New value of ${name}`,
		})

		const clear = async () => {
			status.textContent = ''
			const answer = await send('DELETE', credentialPath(name), {}, NoContent, signal)
			if (signal.aborted) return
			if (!answer.ok) {
				status.textContent = answer.error
				return
			}
			done?.()
		}

		append(
			element('form', {
				classes: styles.row,
				children: [
					value,
					element('button', {
						type: 'submit',
						textContent: 'Replace',
					}),
					optional(
						name.startsWith('webhook/'),
						element('button', {
							type: 'button',
							textContent: 'Generate',
							on: {
								click() {
									value.type = 'text'
									value.value = randomSecret()
								},
							},
						}),
					),
					element('button', {
						type: 'button',
						textContent: 'Clear',
						ariaLabel: `Clear ${name}`,
						on: {
							click() {
								void clear()
							},
						},
					}),
					status,
				],
				on: {
					submit: submitForm({
						status,
						abortSignal: signal,
						send: (form, abortSignal) => send('PUT', credentialPath(name), { value: formText(form, 'value') }, NoContent, abortSignal),
						done() {
							value.type = 'password'
							done?.()
						},
					}),
				},
			}),
		)
	},
})
