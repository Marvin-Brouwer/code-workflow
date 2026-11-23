import { component } from '@rooted/components'
import type { MissingSetting } from '../_shared/settings.mts'
import { CredentialForm } from './credential-form.mts'
import { ProviderForm } from './provider-form.mts'
import { ProviderKeyForm } from './provider-key-form.mts'

/** The setting the form is for, and what it does after. */
export interface FixFormOptions {
	/** The missing setting, as the engine reported it. */
	readonly setting: MissingSetting
	/** Called once the form set it. */
	readonly done?: (() => void) | undefined
}

/**
 * What a missing setting says, and the form that sets it: a provider, a provider's key or a
 * credential. A connector is installed where the engine runs, so for that the message, which names
 * the command, is all there is.
 */
export const FixForm = component<FixFormOptions>({
	name: 'fix-form',
	onMount({ append, element, create, options }) {
		const { setting, done } = options
		const { fix } = setting
		const form = () => {
			if (fix.kind === 'provider')
				return create(ProviderForm, {
					model: fix.model,
					done,
				})
			if (fix.kind === 'provider-key')
				return create(ProviderKeyForm, {
					provider: fix.provider,
					done,
				})
			if (fix.kind === 'credential')
				return create(CredentialForm, {
					name: fix.name,
					example: fix.example,
					done,
				})
			return undefined
		}
		append(
			element('p', {
				textContent: setting.message,
			}),
		)
		const shown = form()
		if (shown !== undefined) append(shown)
	},
})
