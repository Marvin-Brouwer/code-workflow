import type { ElementFactory } from '@rooted/components/elements'

/** Says there is no app yet, and how to deploy one. */
export function noAppText(element: ElementFactory): HTMLParagraphElement {
	return element('p', {
		children: [
			'No app is deployed yet. Deploy it with ',
			element('code', {
				textContent: 'mesh-flow deploy',
			}),
			'.',
		],
	})
}
