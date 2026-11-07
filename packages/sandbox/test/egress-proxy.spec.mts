import { request } from 'node:http'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import { startEgressProxy } from '../src/gvisor/egress-proxy.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

function portOf(server: Server): number {
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('The server is not listening on a TCP port.')
	return address.port
}

/** A TCP server on localhost that answers every connection with one line. */
async function echoServer(): Promise<number> {
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		sockets.add(socket)
		socket.end('hello from upstream\n')
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	onTestFinished(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => {
					resolve()
				})
			}),
	)
	return portOf(server)
}

/** Sends CONNECT over the socket; the status, and what came through the tunnel. */
function tunnel(socketPath: string, target: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const connectRequest = request({ socketPath, method: 'CONNECT', path: target })
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
		connectRequest.end()
	})
}

describe('egress proxy', () => {
	test('tunnels to an allowed host', async () => {
		// Arrange
		const port = await echoServer()
		const socketPath = path.join(await temporaryDirectory(), 'egress.sock')
		const proxy = await startEgressProxy({ socketPath, allow: ['127.0.0.1'] })
		onTestFinished(() => proxy.close())

		// Act
		const result = await tunnel(socketPath, `127.0.0.1:${String(port)}`)

		// Assert
		expect(result).toEqual({ status: 200, body: 'hello from upstream\n' })
	})

	test('refuses a host that is not on the allowlist', async () => {
		// Arrange
		const port = await echoServer()
		const socketPath = path.join(await temporaryDirectory(), 'egress.sock')
		const proxy = await startEgressProxy({ socketPath, allow: ['registry.npmjs.org'] })
		onTestFinished(() => proxy.close())

		// Act
		const result = await tunnel(socketPath, `127.0.0.1:${String(port)}`)

		// Assert
		expect(result.status).toBe(403)
	})

	test('closes while a tunnel is still open', async () => {
		// Arrange
		const holding = createServer(() => undefined)
		await new Promise<void>((resolve) => holding.listen(0, '127.0.0.1', resolve))
		onTestFinished(
			() =>
				new Promise<void>((resolve) => {
					holding.close(() => {
						resolve()
					})
				}),
		)
		const socketPath = path.join(await temporaryDirectory(), 'egress.sock')
		const proxy = await startEgressProxy({ socketPath, allow: ['127.0.0.1'] })
		const open = tunnel(socketPath, `127.0.0.1:${String(portOf(holding))}`)
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Act
		await proxy.close()

		// Assert
		await expect(open).resolves.toEqual({ status: 200, body: '' })
	})
})
