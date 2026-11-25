import { choice, component, optional } from '@rooted/components'
import { send, type Answer } from '../_shared/api.mts'
import { credentialPath, NoContent, providerOfCredential } from '../_shared/settings.mts'
import styles from './forms.css'
import { formStatus } from './form-parts.mts'
import { formText } from './form-text.mts'
import { randomSecret } from './random-secret.mts'
import { submitForm } from './submit-form.mts'

/** Which credential the form sets, and what it does after. */
export interface ReplaceCredentialFormOptions {
	/** The credential to set or replace. */
	readonly name: string
	/** Whether it's stored now: then it's replaced rather than set, and can be cleared. */
	readonly stored: boolean
	/** Called once the credential is set, replaced or cleared. */
	readonly done?: (() => void) | undefined
}

/**
 * Sends a credential's value. A provider's key goes through its provider, which ties it to the
 * origin the config sends it to.
 */
function sendValue(name: string, value: string, abortSignal: AbortSignal): Promise<Answer<unknown>> {
	const provider = providerOfCredential(name)
	if (provider === undefined) return send('PUT', credentialPath(name), { value }, NoContent, abortSignal)
	return send('PUT', `/settings/providers/${encodeURIComponent(provider)}/key`, { key: value }, NoContent, abortSignal)
}

/**
 * One line to set, replace or clear a credential, without opening anything first. The value goes in
 * and never comes back. A webhook secret can be generated, shown once, to copy into the webhook's
 * settings on the other side.
 */
export const ReplaceCredentialForm = component<ReplaceCredentialFormOptions>({
	name: 'replace-credential-form',
	styles,
	onMount({ append, element, options, signal }) {
		const { name, stored, done } = options
		const status = formStatus(element)
		const value = element('input', {
			name: 'value',
			type: 'password',
			required: true,
			autocomplete: 'off',
			placeholder: choice(stored, 'New value', 'Value'),
			ariaLabel: `Value of ${name}`,
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
						textContent: choice(stored, 'Replace', 'Set'),
						ariaLabel: `${choice(stored, 'Replace', 'Set')} ${name}`,
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
					optional(
						stored,
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
					),
					status,
				],
				on: {
					submit: submitForm({
						status,
						abortSignal: signal,
						send: (form, abortSignal) => sendValue(name, formText(form, 'value'), abortSignal),
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
