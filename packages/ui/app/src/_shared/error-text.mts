import type { ElementFactory } from '@rooted/components/elements'

/** Says what went wrong, such as an answer that came back as an error, and is read out when it shows. */
export function errorText(element: ElementFactory, message: string): HTMLParagraphElement {
	return element('p', {
		role: 'alert',
		textContent: message,
	})
}
