import { component } from '@rooted/components'
import { createComponent } from '@rooted/components/elements'

/** What the dialog asks. */
export interface Question {
	/** The question, with what saying yes does. */
	readonly message: string
	/** The label of the button that says yes, such as the action's own name. */
	readonly confirmLabel: string
}

/** What the dialog asks, and where its answer goes. */
interface ConfirmDialogOptions extends Question {
	/** Hears the answer once: `true` for yes, `false` for Cancel or Escape. */
	readonly answer: (confirmed: boolean) => void
}

/** A modal question with Cancel and a yes button, open as soon as it's on the page. */
const ConfirmDialog = component<ConfirmDialogOptions>({
	name: 'confirm-dialog',
	onMount({ append, element, options }) {
		let saidYes = false
		const dialog = element('dialog', {
			on: {
				// Also on Escape, which closes it without a button.
				close() {
					options.answer(saidYes)
				},
			},
			children: [
				element('p', {
					textContent: options.message,
				}),
				element('form', {
					method: 'dialog',
					children: [
						element('button', {
							textContent: 'Cancel',
						}),
						element('button', {
							textContent: options.confirmLabel,
							on: {
								click() {
									saidYes = true
								},
							},
						}),
					],
				}),
			],
		})
		append(dialog)
		dialog.showModal()
	},
})

/**
 * Asks `question` in a modal dialog put in `place`, and answers whether the person said yes once
 * it closes, taking it off the page again.
 *
 * ```ts
 * const yes = await confirmed(page, {
 * 	message: 'This run started on an older build. Continue on it?',
 * 	confirmLabel: 'Continue',
 * })
 * if (yes) await continueRun()
 * ```
 */
export function confirmed(place: HTMLElement, question: Question): Promise<boolean> {
	return new Promise((resolve) => {
		const dialog = createComponent(ConfirmDialog, {
			...question,
			answer: (isConfirmed) => {
				dialog.remove()
				resolve(isConfirmed)
			},
		})
		place.append(dialog)
	})
}
