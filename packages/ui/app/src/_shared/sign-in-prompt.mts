import type { ElementFactory } from '@rooted/components/elements'

/** The schemes a sign-in address may have to be a link: anything else a service sends shows as text. */
const webProtocols: readonly string[] = ['http:', 'https:']

/** Whether `url` is a web address, and so safe to link to. */
export function isWebAddress(url: string): boolean {
	return webProtocols.includes(URL.parse(url)?.protocol ?? '')
}

/** Where to sign in: a link that opens in a new tab, or the address as text when it isn't a web address. */
export function signInLink(element: ElementFactory, url: string): HTMLAnchorElement | string {
	if (!isWebAddress(url)) return url
	return element('a', {
		href: url,
		target: '_blank',
		rel: 'noreferrer',
		textContent: url,
	})
}
