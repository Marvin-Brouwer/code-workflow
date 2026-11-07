import { createServer as createHttpServer, request, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import { startEgressProxy, type EgressProxy } from '../../src/gvisor/egress-proxy.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('The server is not listening on a TCP port.')
	return address.port
}

function closeServer(server: Server): Promise<void> {
	server.closeAllConnections()
	return new Promise((resolve) => {
		server.close(() => {
			resolve()
		})
	})
}

interface Upstream {
	readonly url: string
	/** Every CONNECT target that reached it. */
	readonly targets: string[]
}

/**
 * An upstream HTTP proxy, so the tests reach "the internet" without a network. It answers every
 * tunnel with one line and ends it, or keeps it open when `hold` is set.
 */
async function upstreamProxy(hold = false): Promise<Upstream> {
	const targets: string[] = []
	const sockets = new Set<Socket>()
	const server = createHttpServer()
	server.on('connect', (connectRequest, socket: Socket) => {
		targets.push(connectRequest.url ?? '')
		sockets.add(socket)
		// The proxy resets this side when it closes, which is what the close tests check.
		socket.on('error', () => undefined)
		socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
		if (!hold) socket.end('hello from upstream\n')
	})
	const port = await listen(server)
	onTestFinished(async () => {
		for (const socket of sockets) socket.destroy()
		await closeServer(server)
	})
	return { url: `http://127.0.0.1:${String(port)}`, targets }
}

async function startProxy(allow: readonly string[], upstream: Upstream): Promise<{ proxy: EgressProxy; socketPath: string }> {
	const socketPath = path.join(await temporaryDirectory(), 'egress.sock')
	const proxy = await startEgressProxy({ socketPath, allow, upstreamProxy: upstream.url, signal: AbortSignal.timeout(5000) })
	onTestFinished(() => proxy.close())
	return { proxy, socketPath }
}

interface Tunnel {
	/** Resolves once the proxy answered the CONNECT. */
	readonly opened: Promise<void>
	/** The status, and what came through the tunnel until it ended. */
	readonly result: Promise<{ status: number; body: string }>
}

/** Sends CONNECT over the socket. */
function openTunnel(socketPath: string, target: string): Tunnel {
	const connectRequest = request({ socketPath, method: 'CONNECT', path: target })
	const opened = new Promise<void>((resolve) => {
		connectRequest.once('connect', () => {
			resolve()
		})
	})
	const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
		connectRequest.once('connect', (response, socket, head) => {
			// Whatever arrived in the same packet as the 200 comes in head.
			let body = head.toString('utf8')
			socket.setEncoding('utf8').on('data', (chunk: string) => {
				body += chunk
			})
			socket.once('end', () => {
				resolve({ status: response.statusCode ?? 0, body })
			})
		})
		connectRequest.once('error', reject)
	})
	connectRequest.end()
	return { opened, result }
}

function tunnel(socketPath: string, target: string): Promise<{ status: number; body: string }> {
	return openTunnel(socketPath, target).result
}

describe('egress proxy', () => {
	test('tunnels to an allowed host on port 443', async () => {
		// Arrange
		const upstream = await upstreamProxy()
		const { socketPath } = await startProxy(['registry.npmjs.org'], upstream)

		// Act
		const result = await tunnel(socketPath, 'registry.npmjs.org:443')

		// Assert
		expect(result).toEqual({ status: 200, body: 'hello from upstream\n' })
		expect(upstream.targets).toEqual(['registry.npmjs.org:443'])
	})

	test('matches a host name whatever its case, and with a trailing dot', async () => {
		// Arrange
		const upstream = await upstreamProxy()
		const { socketPath } = await startProxy(['registry.npmjs.org'], upstream)

		// Act
		const result = await tunnel(socketPath, 'Registry.NPMjs.org.:443')

		// Assert
		expect(result.status).toBe(200)
		expect(upstream.targets).toEqual(['registry.npmjs.org:443'])
	})

	test.each(['example.com:443', 'registry.npmjs.org:22', 'registry.npmjs.org', '127.0.0.1:443'])('refuses %s', async (target) => {
		// Arrange
		const upstream = await upstreamProxy()
		const { socketPath } = await startProxy(['registry.npmjs.org'], upstream)

		// Act
		const result = await tunnel(socketPath, target)

		// Assert
		expect(result.status).toBe(403)
		expect(upstream.targets).toEqual([])
	})

	test('closes while a tunnel is still open', async () => {
		// Arrange
		const upstream = await upstreamProxy(true)
		const { proxy, socketPath } = await startProxy(['registry.npmjs.org'], upstream)
		const open = openTunnel(socketPath, 'registry.npmjs.org:443')
		await open.opened

		// Act
		await proxy.close()

		// Assert
		await expect(open.result).resolves.toEqual({ status: 200, body: '' })
	})

	test('closes while a request never finishes its headers', { timeout: 2000 }, async () => {
		// Arrange
		const upstream = await upstreamProxy()
		const { proxy, socketPath } = await startProxy(['registry.npmjs.org'], upstream)
		const client = connect(socketPath)
		onTestFinished(() => {
			client.destroy()
		})
		await new Promise<void>((resolve) => client.once('connect', resolve))
		client.write('GET / HTTP/1.1\r\nHost: x\r\n')

		// Act
		const closing = proxy.close()

		// Assert
		await expect(closing).resolves.toBeUndefined()
	})

	test('keeps running when the signal it was started with aborts later', async () => {
		// Arrange
		const upstream = await upstreamProxy()
		const socketPath = path.join(await temporaryDirectory(), 'egress.sock')
		const started = new AbortController()
		const proxy = await startEgressProxy({ socketPath, allow: ['registry.npmjs.org'], upstreamProxy: upstream.url, signal: started.signal })
		onTestFinished(() => proxy.close())

		// Act
		started.abort()
		const result = await tunnel(socketPath, 'registry.npmjs.org:443')

		// Assert
		expect(result.status).toBe(200)
	})
})
