import { choice, component, optional } from '@rooted/components'
import { send, type Answer } from '../_shared/api.mts'
import { credentialPath, isWebhookCredential, NoContent, providerOfCredential, providerPath } from '../_shared/settings.mts'
import styles from './forms.css'
import { formStatus } from './form-parts.mts'
import { formText } from './form-text.mts'
import { randomSecret } from './random-secret.mts'
import { submitForm } from './submit-form.mts'

/** Which credential the row is of, what it can do, and what happens after. */
export interface CredentialRowFormOptions {
	/** The credential to set, replace or clear. */
	readonly name: string
	/** Whether it's stored now: then it's replaced rather than set, and can be cleared. */
	readonly stored: boolean
	/**
	 * Whether a value can be sent: not for a provider's key without a provider the config declares,
	 * which would have no origin to tie it to. Such a key can still be cleared.
	 */
	readonly settable: boolean
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
	return send('PUT', `${providerPath(provider)}/key`, { key: value }, NoContent, abortSignal)
}

/**
 * One line to set, replace or clear a credential, without opening anything first. The value goes in
 * and never comes back. A webhook secret can be generated, shown once, to copy into the webhook's
 * settings on the other side.
 */
export const CredentialRowForm = component<CredentialRowFormOptions>({
	name: 'credential-row-form',
	styles,
	onMount({ append, element, options, signal }) {
		const { name, stored, settable, done } = options
		const action = choice(stored, 'Replace', 'Set')
		const status = formStatus(element)
		const value = element('input', {
			name: 'value',
			type: 'password',
			required: true,
			autocomplete: 'off',
			placeholder: choice(stored, 'New value', 'Value'),
			ariaLabel: `Value of ${name}`,
		})

		const form = element('form', {
			classes: styles.row,
			children: [
				optional(settable, value),
				optional(
					settable,
					element('button', {
						type: 'submit',
						textContent: action,
						ariaLabel: `${action} ${name}`,
					}),
				),
				optional(
					settable && isWebhookCredential(name),
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
					send: (sent, abortSignal) => sendValue(name, formText(sent, 'value'), abortSignal),
					done() {
						value.type = 'password'
						done?.()
					},
				}),
			},
		})

		// The row's buttons are off while it clears, as while it sends, so a second click can't race the first.
		const clear = async () => {
			const buttons = [...form.querySelectorAll('button')]
			status.textContent = ''
			for (const button of buttons) button.disabled = true
			const answer = await send('DELETE', credentialPath(name), {}, NoContent, signal)
			for (const button of buttons) button.disabled = false
			if (signal.aborted) return
			if (!answer.ok) {
				status.textContent = answer.error
				return
			}
			done?.()
		}

		append(form)
	},
})
