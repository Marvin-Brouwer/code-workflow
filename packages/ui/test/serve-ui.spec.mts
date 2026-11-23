import { request } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { controlSocketPath, openEngineGatewayHome } from '@mesh-flow/engine'
import { duration } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test } from 'vitest'
import { send, servedUi, testPage } from './support/served-ui.mts'
import { standInEngine } from './support/stand-in-engine.mts'

const abortSignal = AbortSignal.timeout(20_000)

const json = { 'content-type': 'application/json' }

describe('access', () => {
	test('swaps the token for a cookie and drops it from the address', async () => {
		// Arrange
		const { url, token } = await servedUi()

		// Act
		const swapped = await send(url, `/runs/?token=${token}`)

		// Assert
		expect(swapped.status).toBe(303)
		expect(swapped.headers['location']).toBe('/runs/')
		expect(swapped.headers['set-cookie']).toEqual([`mesh-flow-ui=${token}; Path=/; HttpOnly; SameSite=Strict`])
	})

	test.each([
		{ request: 'another token', route: '/?token=not-it', headers: {}, status: 401 },
		{ request: 'no cookie', route: '/api/settings/providers', headers: {}, status: 401 },
		{ request: 'another cookie', route: '/api/settings/providers', headers: { cookie: 'mesh-flow-ui=not-it' }, status: 401 },
	])('refuses $request', async ({ route, headers, status }) => {
		// Arrange
		const { url } = await servedUi()

		// Act
		const refused = await send(url, route, { headers })

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

describe.skipIf(process.platform === 'win32')('closing', () => {
	test('closes promptly while a request to an engine that never answers is open', async () => {
		// Arrange
		const { url, cookie, home, stopping, served } = await servedUi()
		const sockets: Socket[] = []
		const silent = createServer((socket) => sockets.push(socket))
		await new Promise<void>((resolve) => silent.listen(controlSocketPath(home), resolve))
		onTestFinished(() => {
			for (const socket of sockets) socket.destroy()
			silent.close()
		})
		const open = send(url, '/api/engine/runs', { headers: { cookie } }).catch((error: unknown) => error)
		await expect.poll(() => sockets.length).toBe(1)

		// Act
		const started = Date.now()
		stopping.abort()
		await served.closed

		// Assert
		expect(Date.now() - started).toBeLessThan(duration.of('2s').to('ms'))
		expect(await open).toBeInstanceOf(Error)
	})
})

describe.skipIf(process.platform === 'win32')("the engine's change stream", () => {
	test('passes through, and does not hold up closing while it is open', async () => {
		// Arrange
		const { url, cookie, home, stopping, served } = await servedUi()
		await standInEngine(home)
		const stream = new Promise<{ text: () => string }>((resolve, reject) => {
			const outgoing = request(
				{ host: url.hostname, port: url.port, path: '/api/engine/changes', headers: { host: url.host, cookie } },
				(response) => {
					let text = ''
					response.on('data', (chunk: Buffer) => {
						text += chunk.toString('utf8')
						resolve({ text: () => text })
					})
					response.on('error', () => undefined)
				},
			)
			outgoing.on('error', reject)
			outgoing.end()
		})
		const { text } = await stream

		// Act
		const started = Date.now()
		stopping.abort()
		await served.closed

		// Assert
		expect(text()).toContain('event: ready')
		expect(Date.now() - started).toBeLessThan(duration.of('2s').to('ms'))
	})
})
