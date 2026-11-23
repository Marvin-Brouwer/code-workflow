import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { uiAccess } from '../src/server/ui-access.mts'

/** The UI's access check on port 80, where browsers leave the port out of `Host` and `Origin`, in front of one route. */
function onPort80() {
	const token = 'the-token'
	const app = new Hono()
	app.use(uiAccess({ token, host: '127.0.0.1:80' }))
	app.put('/api/change', (context) => context.body(null, 204))
	return { app, token }
}

describe('uiAccess', () => {
	test("lets a change from the UI's own page in on port 80, whose Origin has no port", async () => {
		// Arrange
		const { app, token } = onPort80()
		const swapped = await app.request(`/?token=${token}`, { headers: { host: '127.0.0.1' } })
		const cookie = (swapped.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

		// Act
		const changed = await app.request('/api/change', {
			method: 'PUT',
			headers: {
				host: '127.0.0.1',
				cookie,
				origin: 'http://127.0.0.1',
				'sec-fetch-site': 'same-origin',
				'content-type': 'application/json',
			},
			body: '{}',
		})

		// Assert
		expect(swapped.status).toBe(303)
		expect(changed.status).toBe(204)
	})
})
