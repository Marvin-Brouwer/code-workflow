import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

/**
 * The cookie the browser that opened the UI's address holds, named after the port of `host`
 * (`127.0.0.1:4800`). Cookies aren't kept apart by port, so two UIs on one machine would otherwise
 * overwrite each other's.
 */
export function accessCookieName(host: string): string {
	return `mesh-flow-ui-${host.slice(host.lastIndexOf(':') + 1)}`
}

/**
 * What `Sec-Fetch-Site` may say: the UI's own page, or the user opening the address. A page on
 * another port of 127.0.0.1 sends `same-site`, since browsers count every port as one site.
 */
const ownFetchSites: readonly string[] = ['same-origin', 'none']

/** A new token, made each time the UI is served: 32 random bytes. */
export function newAccessToken(): string {
	return randomBytes(32).toString('base64url')
}

/** What lets a request in. */
export interface UiAccessOptions {
	readonly token: string
	/** The `Host` a request has to name: the address the UI listens on, such as `127.0.0.1:4800`. */
	readonly host: string
}

/**
 * Lets in only the browser that opened the UI's address, on the machine it runs on:
 *
 * - the `Host` header has to be the address the UI listens on, so a site that points its own name
 *   at 127.0.0.1 (DNS rebinding) gets nothing;
 * - `?token=` with the token swaps it for an `HttpOnly`, `SameSite=Strict` cookie and sends the
 *   browser to the same page without it, so the token doesn't stay in the address bar;
 * - every other request needs that cookie;
 * - a request from another origin is refused, by its `Sec-Fetch-Site` and its `Origin`, since the
 *   cookie alone doesn't keep out a page on another port of 127.0.0.1 (a dev server's, say), which
 *   the browser counts as the same site;
 * - a change (anything but `GET`) has to be JSON, which a form on another site can't send without
 *   asking first.
 *
 * It's the local way in. Hosted, a sign-in per user takes its place in front of the same routes.
 */
export function uiAccess({ token, host }: UiAccessOptions): MiddlewareHandler {
	const cookie = accessCookieName(host)
	return async (c, next) => {
		if (c.req.header('host') !== host) return c.text('This address is not the one the UI listens on.', 403)
		if (!fromOwnOrigin(c.req.header('sec-fetch-site'), c.req.header('origin'), host))
			return c.text('Only the UI itself can use this address.', 403)
		const offered = c.req.query('token')
		if (offered !== undefined) {
			if (!sameSecret(offered, token)) return c.text('That token is not the one `mesh-flow ui` printed.', 401)
			setCookie(c, cookie, token, { httpOnly: true, sameSite: 'Strict', path: '/' })
			const url = new URL(c.req.url)
			url.searchParams.delete('token')
			return c.redirect(`${url.pathname}${url.search}`, 303)
		}
		const held = getCookie(c, cookie)
		if (held === undefined || !sameSecret(held, token)) return c.text('Open the address `mesh-flow ui` printed.', 401)
		if (c.req.method !== 'GET' && c.req.header('content-type')?.startsWith('application/json') !== true)
			return c.json({ error: 'Send changes as JSON.' }, 415)
		await next()
		return undefined
	}
}

/** Whether a request comes from the UI's own page, or from the user opening its address. A header a browser didn't send doesn't count against it. */
function fromOwnOrigin(fetchSite: string | undefined, origin: string | undefined, host: string): boolean {
	if (fetchSite !== undefined && !ownFetchSites.includes(fetchSite)) return false
	return origin === undefined || origin === `http://${host}`
}

/** Compares two secrets in a time that doesn't tell how much of them matched. */
function sameSecret(given: string, expected: string): boolean {
	const a = Buffer.from(given)
	const b = Buffer.from(expected)
	return a.length === b.length && timingSafeEqual(a, b)
}
