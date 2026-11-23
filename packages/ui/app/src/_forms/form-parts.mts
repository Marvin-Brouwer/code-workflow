import type { ElementFactory } from '@rooted/components/elements'
import styles from './forms.css'

/** Where a form says why it was refused: hidden while it's empty, and read out when it changes. */
export function formStatus(element: ElementFactory): HTMLParagraphElement {
	return element('p', {
		classes: styles.status,
		role: 'alert',
	})
}

/** A form's buttons: its submit button with `label`, then `more`. */
export function submitActions(element: ElementFactory, label: string, ...more: readonly HTMLElement[]): HTMLDivElement {
	return element('div', {
		classes: styles.actions,
		children: [
			element('button', {
				type: 'submit',
				textContent: label,
			}),
			...more,
		],
	})
}
