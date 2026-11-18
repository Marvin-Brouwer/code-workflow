import { component } from '@rooted/components'
import type { MissingSetting } from '../_shared/settings.mts'
import { CredentialForm } from './credential-form.mts'
import { ProviderForm } from './provider-form.mts'
import { ProviderKeyForm } from './provider-key-form.mts'

export interface FixFormOptions {
	readonly setting: MissingSetting
	/** Called once the form set it. */
	readonly done?: () => void
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
		const then = done === undefined ? {} : { done }
		const form = () => {
			if (fix.kind === 'provider') return create(ProviderForm, { model: fix.model, ...then })
			if (fix.kind === 'provider-key') return create(ProviderKeyForm, { provider: fix.provider, ...then })
			if (fix.kind === 'credential')
				return create(CredentialForm, { name: fix.name, ...(fix.example === undefined ? {} : { example: fix.example }), ...then })
			return undefined
		}
		append(element('p', { textContent: setting.message }))
		const shown = form()
		if (shown !== undefined) append(shown)
	},
})
