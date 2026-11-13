import type { HostToolContext } from '@mesh-flow/gateway'
import { defaultRequestRetry, type AtlassianHostOptions } from '../host-options.mts'
import { readSiteSettings } from '../site-settings.mts'
import type { Download } from './attachments.mts'
import { jiraCloud } from './jira-cloud.mts'
import { jiraDataCenter } from './jira-data-center.mts'
import type { JiraSite } from './jira-site.mts'

/** A site for one call, with the credentials from the credential store. */
export type JiraApi = (context: HostToolContext) => Promise<JiraSite>

/**
 * Opens Jira for host tools: every call reads the site and token from the credential store, so a
 * changed setting counts at once. With an email it's a Cloud site, signed in with the email and API
 * token; without one it's Data Center, with the token as a personal access token.
 */
export function jiraApi(options: AtlassianHostOptions = {}): JiraApi {
	return async (context) => {
		const settings = await readSiteSettings('jira', context)
		const common = {
			host: settings.url,
			retry: options.retry ?? defaultRequestRetry,
			// A site's custom configuration often differs from Atlassian's schema; the connector reads what it needs itself.
			onSchemaMismatch: 'silent' as const,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		}
		// An attachment is read past the client, which has no call for its bytes, signed in the way the client is.
		const send = options.fetch ?? fetch
		if (settings.deployment === 'cloud') {
			const basic = Buffer.from(`${settings.email}:${settings.token}`).toString('base64')
			return jiraCloud(
				{ ...common, auth: { type: 'basic', email: settings.email, apiToken: settings.token } },
				downloadWith(send, `Basic ${basic}`),
			)
		}
		return jiraDataCenter({ ...common, auth: { type: 'bearer', token: settings.token } }, downloadWith(send, `Bearer ${settings.token}`))
	}
}

/**
 * Reads an image attachment signed in, as the API does, up to `maxBytes`. A file that can't be
 * read, gone or refused or the site down, one larger than that, and an answer that isn't an image,
 * such as a sign-in page, are `undefined`: the issue is still worth reading without it. A stop is
 * thrown.
 */
function downloadWith(send: typeof fetch, authorization: string): Download {
	return async (url, maxBytes, abortSignal) => {
		try {
			const response = await send(url, { headers: { authorization }, signal: abortSignal })
			const declared = Number(response.headers.get('content-length') ?? 0)
			const isImage = (response.headers.get('content-type') ?? '').startsWith('image/')
			if (!response.ok || !isImage || declared > maxBytes || response.body === null) {
				await response.body?.cancel()
				return undefined
			}
			return await readUpTo(response.body, maxBytes)
		} catch (error) {
			abortSignal.throwIfAborted()
			if (error instanceof TypeError) return undefined
			throw error
		}
	}
}

/** A body's bytes, or `undefined` once it passes `maxBytes`: the rest is never read. */
async function readUpTo(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | undefined> {
	const chunks: Uint8Array[] = []
	let length = 0
	for await (const chunk of body) {
		length += chunk.byteLength
		if (length > maxBytes) {
			// Leaving the loop early cancels the stream.
			return undefined
		}
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}
