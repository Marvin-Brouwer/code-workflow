import type { HostToolContext } from '@mesh-flow/gateway'

/** The name of the GitLab token in the gateway's credential store: `mesh-flow credential set gitlab/token`. */
export const tokenCredential = 'gitlab/token'

/** The name of the GitLab URL in the gateway's credential store, for a GitLab of your own: `mesh-flow credential set gitlab/url`. */
export const urlCredential = 'gitlab/url'

/** Where the connector goes when no URL is set. */
export const defaultSiteUrl = 'https://gitlab.com'

/** The GitLab the connector reaches, and the token it reaches it with. */
export interface Site {
	/** The GitLab's base URL, without a slash at the end, such as `https://gitlab.com`. */
	readonly url: string
	readonly token: string
}

/**
 * The site from the call's credential store: the URL under {@link urlCredential}, gitlab.com when
 * there is none, and the token under {@link tokenCredential}, or an error saying how to set it.
 */
export async function readSite({ credentials, abortSignal }: HostToolContext): Promise<Site> {
	const [url, token] = await Promise.all([credentials.get(urlCredential, abortSignal), credentials.get(tokenCredential, abortSignal)])
	if (token === undefined) throw new Error(`There is no GitLab token. Set it with \`mesh-flow credential set ${tokenCredential}\`.`)
	return { url: siteUrl(url ?? defaultSiteUrl), token }
}

/** A GitLab URL as the connector takes it: http or https, without a slash at the end. */
function siteUrl(text: string): string {
	const parsed = URL.parse(text)
	if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
		throw new Error(`${urlCredential} is ${text}, which isn't a URL. Set it to where your GitLab is, such as https://gitlab.example.com.`)
	return parsed.href.replace(/\/+$/, '')
}
