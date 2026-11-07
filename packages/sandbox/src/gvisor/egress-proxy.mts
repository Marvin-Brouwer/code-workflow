import { chmod, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { connect, type Socket } from 'node:net'

export interface EgressProxy {
	/** Stops listening, and ends every open tunnel and connection right away. */
	close(): Promise<void>
}

export interface EgressProxyOptions {
	readonly socketPath: string
	/** Host names a tunnel may go to, on port 443. Anything else gets a 403. */
	readonly allow: readonly string[]
	/** An HTTP proxy between this machine and the internet, as `http://host:port`. */
	readonly upstreamProxy?: string
	/** Stops a start that hasn't finished. Once started, only `close` stops the proxy. */
	readonly signal: AbortSignal
}

const connectTimeoutMs = 10_000

/**
 * An HTTP CONNECT proxy on a Unix socket that tunnels only to allowed hosts, on port 443. A gVisor
 * sandbox has no network; this socket, bind-mounted into it, is its only way out.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
	const allowed = new Set(options.allow.map(normalizeHost))
	const open = new Set<{ destroy(): unknown }>()
	const server = createServer((_request, response) => {
		response.writeHead(405).end('Only CONNECT is supported.\n')
	})
	server.on('connect', (connectRequest, client: Socket, head: Buffer) => {
		const host = allowedHost(connectRequest.url ?? '', allowed)
		if (host === undefined) {
			client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
			return
		}
		trackUntilClosed(open, client)
		client.once('error', () => client.destroy())
		const upstream = openUpstream(host, options.upstreamProxy)
		open.add(upstream.connecting)
		client.once('close', () => upstream.connecting.destroy())
		upstream.socket.then(
			(remote) => {
				open.delete(upstream.connecting)
				trackUntilClosed(open, remote)
				pipeTunnel(client, remote, head)
			},
			() => {
				open.delete(upstream.connecting)
				client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
			},
		)
	})

	// Not listen's own signal option: that closes the server whenever the signal aborts, also
	// long after this start is done. Listening on a Unix socket is quick, so a check either side
	// is enough.
	options.signal.throwIfAborted()
	await rm(options.socketPath, { force: true })
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(options.socketPath, resolve)
	})
	if (options.signal.aborted) {
		server.close()
		options.signal.throwIfAborted()
	}
	// runsc's gofer opens the socket for the sandbox. It runs as root without CAP_DAC_OVERRIDE,
	// so a socket made by another user has to be writable for everyone.
	await chmod(options.socketPath, 0o666)

	return {
		close: () =>
			new Promise((resolve) => {
				for (const connection of open) connection.destroy()
				server.close(() => {
					resolve()
				})
				// Requests that never finish their headers would keep `close` waiting.
				server.closeAllConnections()
			}),
	}
}

function trackUntilClosed(open: Set<{ destroy(): unknown }>, socket: Socket): void {
	open.add(socket)
	socket.once('close', () => open.delete(socket))
}

/** Confirms the tunnel to the client and connects both ends. Either end closing ends the other. */
function pipeTunnel(client: Socket, remote: Socket, head: Buffer): void {
	remote.once('error', () => client.destroy())
	client.once('close', () => remote.destroy())
	client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
	remote.write(head)
	remote.pipe(client).pipe(remote)
}

/** Lowercase, without a trailing dot: `Registry.npmjs.org.` is `registry.npmjs.org`. */
function normalizeHost(host: string): string {
	return host.toLowerCase().replace(/\.$/, '')
}

/** The host of a `host:443` CONNECT target, when it's allowed. */
function allowedHost(target: string, allowed: ReadonlySet<string>): string | undefined {
	const match = /^([^:]+):443$/.exec(target)
	if (match?.[1] === undefined) return undefined
	const host = normalizeHost(match[1])
	return allowed.has(host) ? host : undefined
}

interface Upstream {
	/** Destroying it gives up on the connection while it is still being made. */
	readonly connecting: { destroy(): unknown }
	readonly socket: Promise<Socket>
}

function openUpstream(host: string, upstreamProxy: string | undefined): Upstream {
	if (upstreamProxy === undefined) {
		const socket = connect(443, host)
		socket.setTimeout(connectTimeoutMs, () => {
			socket.destroy(new Error(`Connecting to ${host} timed out.`))
		})
		return {
			connecting: socket,
			socket: new Promise((resolve, reject) => {
				socket.once('connect', () => {
					socket.setTimeout(0)
					resolve(socket)
				})
				socket.once('error', reject)
				socket.once('close', () => {
					reject(new Error(`The connection to ${host} closed.`))
				})
			}),
		}
	}
	const proxy = new URL(upstreamProxy)
	const tunnel = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${host}:443` })
	tunnel.setTimeout(connectTimeoutMs, () => {
		tunnel.destroy(new Error(`The upstream proxy didn't answer for ${host}.`))
	})
	return {
		connecting: tunnel,
		socket: new Promise((resolve, reject) => {
			tunnel.once('connect', (response, socket, head) => {
				if (response.statusCode === 200) {
					// What the far end sent in the same packet as the 200 comes in head.
					if (head.length > 0) socket.unshift(head)
					resolve(socket)
				} else {
					socket.destroy()
					reject(new Error(`The upstream proxy answered ${String(response.statusCode)}.`))
				}
			})
			tunnel.once('error', reject)
			tunnel.once('close', () => {
				reject(new Error(`The upstream proxy closed the tunnel to ${host}.`))
			})
			tunnel.end()
		}),
	}
}
