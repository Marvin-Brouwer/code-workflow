import { component } from '@rooted/components'

/** What the control says, and what it does once confirmed. */
interface ConfirmButtonOptions {
	/** What the closed control says, such as "Remove". */
	readonly summary: string
	/** What the button that does it says, once opened, such as "Remove github/token". */
	readonly label: string
	/** What it does, once confirmed. */
	readonly confirmed: () => void
}

/** A control that has to be opened before its button does anything, for a change that can't be undone. */
export const ConfirmButton = component<ConfirmButtonOptions>({
	name: 'confirm-button',
	onMount({ append, element, options }) {
		const { summary, label, confirmed } = options
		append(
			element('details', {
				children: [
					element('summary', {
						textContent: summary,
					}),
					element('button', {
						type: 'button',
						textContent: label,
						on: {
							click() {
								confirmed()
							},
						},
					}),
				],
			}),
		)
	},
})
