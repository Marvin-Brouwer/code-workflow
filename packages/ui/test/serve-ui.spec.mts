import { createServer, type Socket } from 'node:net'
import { duration } from '@mesh-flow/duration'
import { controlSocketPath, openEngineGatewayHome } from '@mesh-flow/engine'
import { describe, expect, onTestFinished, test } from 'vitest'
import { send, servedUi, testPage } from './support/served-ui.mts'

const abortSignal = duration.of('20s').toAbortSignal()

const json = { 'content-type': 'application/json' }

describe('access', () => {
	test('swaps the token for a cookie and drops it from the address', async () => {
		// Arrange
		const { url, token, cookieName } = await servedUi()

		// Act
		const swapped = await send(url, `/runs/?token=${token}`)

		// Assert
		expect(swapped.status).toBe(303)
		expect(swapped.headers['location']).toBe('/runs/')
		expect(swapped.headers['set-cookie']).toEqual([
			expect.stringMatching(new RegExp(`^${cookieName}=[\\w-]+; Path=/; HttpOnly; SameSite=Strict$`)),
		])
		expect(swapped.headers['set-cookie']?.[0]).not.toContain(token)
	})

	test.each([
		{ request: 'another token', route: '/?token=not-it', cookie: undefined, status: 401 },
		{ request: 'no cookie', route: '/api/settings/providers', cookie: undefined, status: 401 },
		{ request: 'another cookie', route: '/api/settings/providers', cookie: 'not-it', status: 401 },
	])('refuses $request', async ({ route, cookie, status }) => {
		// Arrange
		const { url, cookieName } = await servedUi()

		// Act
		const refused = await send(url, route, { headers: cookie === undefined ? {} : { cookie: `${cookieName}=${cookie}` } })

		// Assert
		expect(refused.status).toBe(status)
	})

	test('refuses a request for another host, as after DNS rebinding, even with the cookie', async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const refused = await send(url, '/api/settings/providers', { headers: { host: `rebound.example:${url.port}`, cookie } })

		// Assert
		expect(refused.status).toBe(403)
	})

	test.each([
		{ request: 'a page on another port, which the browser counts as the same site', headers: { 'sec-fetch-site': 'same-site' } },
		{ request: 'another site', headers: { 'sec-fetch-site': 'cross-site' } },
		{ request: 'another origin, by its Origin', headers: { origin: 'http://127.0.0.1:5173' } },
	])('refuses a request from $request, even with the cookie', async ({ headers }) => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const refused = await send(url, '/api/settings/providers', { headers: { cookie, ...headers } })

		// Assert
		expect(refused.status).toBe(403)
	})

	test("lets in the UI's own page and the user opening its address", async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const fromPage = await send(url, '/api/settings/providers', {
			headers: { cookie, 'sec-fetch-site': 'same-origin', origin: `http://${url.host}` },
		})
		const opened = await send(url, '/', { headers: { cookie, 'sec-fetch-site': 'none' } })

		// Assert
		expect(fromPage.status).toBe(200)
		expect(opened.status).toBe(200)
	})

	test('names its cookie after its port, so two UIs keep their own', async () => {
		// Arrange
		const first = await servedUi()
		const second = await servedUi()

		// Act
		const refused = await send(second.url, '/api/settings/providers', { headers: { cookie: first.cookie } })

		// Assert
		expect(first.cookieName).not.toBe(second.cookieName)
		expect(refused.status).toBe(401)
	})

	test("refuses a change that isn't JSON, as a form on another site would send it", async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const refused = await send(url, '/api/settings/credentials/github/token', {
			method: 'PUT',
			headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
			body: 'value=stolen',
		})

		// Assert
		expect(refused.status).toBe(415)
	})
})

describe('the page', () => {
	test('may run only its own scripts, in no frame', async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const page = await send(url, '/', { headers: { cookie } })

		// Assert
		expect(page.headers['content-security-policy']).toContain("script-src 'self'")
		expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
	})

	test("answers a page's path with index.html, for the page's own router", async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const page = await send(url, '/runs/run-1/', { headers: { cookie } })

		// Assert
		expect(page.status).toBe(200)
		expect(page.body).toBe(testPage)
	})
})

describe('settings', () => {
	test('sets a credential where the CLI reads it, and lists its name but never its value', async () => {
		// Arrange
		const { url, cookie, home } = await servedUi()

		// Act
		const set = await send(url, '/api/settings/credentials/github/token', {
			method: 'PUT',
			headers: { cookie, ...json },
			body: JSON.stringify({ value: 'ghp-secret' }),
		})
		const listed = await send(url, '/api/settings/credentials', { headers: { cookie } })

		// Assert
		expect(set.status).toBe(204)
		expect(JSON.parse(listed.body)).toEqual(['github/token'])
		const gatewayHome = await openEngineGatewayHome(home, abortSignal, { keychain: false })
		expect(await gatewayHome.credentials.get('github/token', abortSignal)).toBe('ghp-secret')
	})

	test('adds a provider with its key, and lists it with the key set', async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const added = await send(url, '/api/settings/providers/work', {
			method: 'PUT',
			headers: { cookie, ...json },
			body: JSON.stringify({ kind: 'anthropic', key: 'sk-secret' }),
		})
		const listed = await send(url, '/api/settings/providers', { headers: { cookie } })

		// Assert
		expect(added.status).toBe(204)
		expect(JSON.parse(listed.body)).toEqual([{ name: 'work', kind: 'anthropic', hasKey: true }])
	})

	test('refuses a provider kind there is none of', async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const refused = await send(url, '/api/settings/providers/work', {
			method: 'PUT',
			headers: { cookie, ...json },
			body: JSON.stringify({ kind: 'no-such-kind' }),
		})

		// Assert
		expect(refused.status).toBe(400)
		expect(JSON.parse(refused.body)).toEqual({ error: expect.stringContaining('There is no provider kind no-such-kind') as unknown })
	})
	test.each([
		{ request: "a body that doesn't fit", route: '/api/settings/providers/work/key', method: 'PUT', body: '{}' },
		{ request: "a body that isn't JSON", route: '/api/settings/providers/work/key', method: 'PUT', body: '{"key": ' },
		{ request: "a name that isn't a credential's", route: '/api/settings/credentials/no-slash', method: 'DELETE', body: '{}' },
	])('answers $request with 400', async ({ route, method, body }) => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const refused = await send(url, route, { method, headers: { cookie, ...json }, body })

		// Assert
		expect(refused.status).toBe(400)
	})
})

describe('without an engine', () => {
	test('says the engine is not running, and answers its routes with 503', async () => {
		// Arrange
		const { url, cookie } = await servedUi()

		// Act
		const status = await send(url, '/api/engine/status', { headers: { cookie } })
		const runs = await send(url, '/api/engine/runs', { headers: { cookie } })

		// Assert
		expect(JSON.parse(status.body)).toEqual({ running: false })
		expect(runs.status).toBe(503)
		expect(JSON.parse(runs.body)).toEqual({ error: expect.stringContaining('No engine is running') as unknown })
	})
})

/** An engine that takes connections on `home`'s control socket and never answers, and the connections it holds. */
async function silentEngine(home: string) {
	const sockets: Socket[] = []
	const closedSockets: Socket[] = []
	const silent = createServer((socket) => {
		sockets.push(socket)
		socket.once('close', () => closedSockets.push(socket))
		// Reads what comes, so the end of a dropped connection comes through.
		socket.resume()
	})
	await new Promise<void>((resolve) => silent.listen(controlSocketPath(home), resolve))
	onTestFinished(() => {
		for (const socket of sockets) socket.destroy()
		silent.close()
	})
	return { sockets, closedSockets }
}

describe.skipIf(process.platform === 'win32')('closing', () => {
	test.each([
		{ request: 'the runs', route: '/api/engine/runs', method: 'GET' },
		{ request: 'a sign-in, which waits until it is done', route: '/api/engine/sign-ins/cloud', method: 'POST' },
	])('closes promptly while $request waits on an engine that never answers, and drops that call', async ({ route, method }) => {
		// Arrange
		const { url, cookie, home, stopping, served } = await servedUi()
		const engine = await silentEngine(home)
		const open = send(url, route, method === 'GET' ? { headers: { cookie } } : { method, headers: { cookie, ...json }, body: '{}' }).catch(
			(error: unknown) => error,
		)
		await expect.poll(() => engine.sockets.length).toBe(1)

		// Act
		const started = Date.now()
		stopping.abort()
		await served.closed

		// Assert
		expect(Date.now() - started).toBeLessThan(duration.of('2s').to('ms'))
		expect(await open).toBeInstanceOf(Error)
		await expect.poll(() => engine.closedSockets.length).toBe(1)
	})

	test('drops the call to the engine when the browser leaves', async () => {
		// Arrange
		const { url, cookie, home } = await servedUi()
		const engine = await silentEngine(home)
		const leaving = new AbortController()
		const open = send(url, '/api/engine/sign-ins/cloud', {
			method: 'POST',
			headers: { cookie, ...json },
			body: '{}',
			abortSignal: leaving.signal,
		}).catch((error: unknown) => error)
		await expect.poll(() => engine.sockets.length).toBe(1)

		// Act
		leaving.abort()

		// Assert
		expect(await open).toBeInstanceOf(Error)
		await expect.poll(() => engine.closedSockets.length).toBe(1)
	})
})
