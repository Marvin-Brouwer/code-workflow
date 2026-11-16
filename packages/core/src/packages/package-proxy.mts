import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { TLSSocket } from 'node:tls'
import { packageRegistryHosts, type PackageRegistry, type PackageRequest, type PackageResponse } from '@mesh-flow/protocol'
import { describeError } from '../run/describe-error.mts'
import type { CertificateAuthority } from './certificate-authority.mts'

/** What the proxy is for, and how it gets packages. */
export interface PackageProxyOptions {
	/** The registries it serves: requests for other hosts are refused. */
	readonly registries: readonly PackageRegistry[]
	/** Signs the certificates the proxy shows for the registries' hosts. */
	readonly authority: CertificateAuthority
	/** Fetches a package, through the gateway. */
	readonly fetch: (request: PackageRequest, abortSignal: AbortSignal) => Promise<PackageResponse>
	/** Stops the proxy: every request it still serves is aborted. */
	readonly abortSignal: AbortSignal
}

/** A running package proxy. */
export interface PackageProxy {
	/** Where it listens, as `HTTPS_PROXY` takes it: `http://127.0.0.1:<port>`. */
	readonly url: string
	/** Stops listening and drops every connection. */
	readonly close: () => Promise<void>
}

/** Where the proxy listens: loopback, the only network a sandbox has. */
const loopback = '127.0.0.1'

/** The only port it tunnels to: package managers fetch over HTTPS. */
const httpsPort = '443'

const forbidden = 403
const methodNotAllowed = 405
const badGateway = 502

/**
 * The proxy package managers in the sandbox reach on `HTTPS_PROXY`, such as `npm ci` and
 * `dotnet restore`. The sandbox has no network, so nothing it tunnels goes out: for the hosts of
 * the app's registries it ends TLS itself, with a certificate from the sandbox's own authority, and
 * answers each `GET` with a fetch through the gateway. Anything else, another host, plain HTTP or a
 * write, is refused here.
 */
export async function startPackageProxy(options: PackageProxyOptions): Promise<PackageProxy> {
	const registryOfHost = new Map(options.registries.map((registry) => [packageRegistryHosts[registry], registry]))
	const registryOfSocket = new WeakMap<Socket, PackageRegistry>()
	const connections = new Set<Duplex>()

	const serve = async (request: IncomingMessage, response: ServerResponse) => {
		const registry = registryOfSocket.get(request.socket)
		if (registry === undefined || request.url === undefined) {
			refuse(response, forbidden, 'Not a registry this run restores from.')
			return
		}
		if (request.method !== 'GET') {
			refuse(response, methodNotAllowed, 'Package registries are only read from here.')
			return
		}
		const stopped = new AbortController()
		response.once('close', () => {
			stopped.abort(new Error('The package manager went away.'))
		})
		try {
			const accept = request.headers.accept
			const answer = await options.fetch(
				{ registry, path: request.url, ...(accept === undefined ? {} : { accept }) },
				AbortSignal.any([stopped.signal, options.abortSignal]),
			)
			const body = Buffer.from(answer.body, 'base64')
			response.writeHead(answer.status, { ...answer.headers, 'content-length': String(body.length) })
			response.end(body)
		} catch (error) {
			refuse(response, badGateway, describeError(error))
		}
	}

	const inner = createServer((request, response) => {
		void serve(request, response)
	})
	const outer = createServer((_request, response) => {
		refuse(response, forbidden, 'Only HTTPS to the package registries goes through here.')
	})
	outer.on('connection', (socket) => {
		track(connections, socket)
	})
	outer.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
		const [host = '', port] = (request.url ?? '').split(':')
		const registry = registryOfHost.get(host)
		if (registry === undefined || port !== httpsPort) {
			client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
			return
		}
		client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
		if (head.length > 0) client.unshift(head)
		const secure = new TLSSocket(client, { isServer: true, secureContext: options.authority.contextFor(host) })
		secure.on('error', () => secure.destroy())
		track(connections, secure)
		registryOfSocket.set(secure, registry)
		inner.emit('connection', secure)
	})

	await new Promise<void>((resolve, reject) => {
		outer.once('error', reject)
		outer.listen(0, loopback, () => {
			outer.off('error', reject)
			resolve()
		})
	})
	const address = outer.address()
	const port = typeof address === 'object' && address !== null ? address.port : 0

	const close = async () => {
		for (const connection of connections) connection.destroy()
		await new Promise<void>((resolve) => {
			outer.close(() => {
				resolve()
			})
		})
		inner.close()
	}
	options.abortSignal.addEventListener(
		'abort',
		() => {
			void close()
		},
		{ once: true },
	)
	return Object.freeze({ url: `http://${loopback}:${String(port)}`, close })
}

function refuse(response: ServerResponse, status: number, message: string): void {
	if (response.headersSent) {
		response.destroy()
		return
	}
	response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
	response.end(`${message}\n`)
}

function track(connections: Set<Duplex>, connection: Duplex): void {
	connections.add(connection)
	connection.once('close', () => connections.delete(connection))
}
