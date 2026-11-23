import type { MiddlewareHandler } from 'hono'

/**
 * What the page may load: only its own scripts, styles and data, in no frame. A run's events are
 * written in the sandbox and can carry prompt-injected text; the page shows them as text, and this
 * keeps a slip from running a script that could use the UI's cookie. Inline `style` attributes
 * stay allowed: they can't run code.
 */
const contentSecurityPolicy = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join('; ')

/** Sends the {@link contentSecurityPolicy} with every answer, and tells the browser not to guess content types. */
export function pageHeaders(): MiddlewareHandler {
	return async (context, next) => {
		await next()
		context.header('content-security-policy', contentSecurityPolicy)
		context.header('x-content-type-options', 'nosniff')
	}
}
