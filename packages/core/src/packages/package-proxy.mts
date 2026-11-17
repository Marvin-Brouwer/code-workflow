import { open, rm } from 'node:fs/promises'
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TLSSocket } from 'node:tls'
import { PackageRequest, registryHost, registryPaths, type PackageRegistry } from '@mesh-flow/protocol'
import { GatewayCallError } from '../gateway/gateway-client.mts'
import type { GatewayFetch } from '../gateway/gateway-packages.mts'
import { describeError } from '../run/describe-error.mts'
import type { CertificateAuthority } from './certificate-authority.mts'

/** What the proxy is for, and how it gets packages. */
export interface PackageProxyOptions {
	/** The registries it serves: requests for other hosts are refused. */
	readonly registries: readonly PackageRegistry[]
	/** Signs the certificates the proxy shows for the registries' hosts. */
	readonly authority: CertificateAuthority
	/** Fetches a package, through the gateway. */
	readonly fetchThroughGateway: GatewayFetch
	/** Stops the proxy, as {@link PackageProxy.close} does: every request it still serves is aborted. */
	readonly abortSignal: AbortSignal
}

/** A running package proxy. */
export interface PackageProxy {
	/** Where it listens, as `HTTPS_PROXY` takes it: `http://127.0.0.1:<port>`. */
	readonly url: string
	/** Stops listening and drops every connection, as aborting its signal does. */
	readonly close: () => Promise<void>
}

/** How much of a refused path the answer repeats. */
const maxEchoedLength = 200

/** Where the proxy listens: loopback, the only network a sandbox has. */
const loopback = '127.0.0.1'

/** The only port it tunnels to: package managers fetch over HTTPS. */
const httpsPort = '443'

const established = 200
const badRequest = 400
const forbidden = 403
const methodNotAllowed = 405
const badGateway = 502

/** The status line that starts an answer to `CONNECT`, which isn't sent through a `ServerResponse`. */
function statusLine(status: number): string {
	return `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\n\r\n`
}

/** A host as `CONNECT` names it, compared as DNS does: in lower case, without a trailing dot. */
function normalizedHost(host: string): string {
	return host.toLowerCase().replace(/\.$/, '')
}

/**
 * The registry on `host` that `path` is on: the one with the longest of its paths that `path` starts
 * with, so two repositories on one host each get their own fetches.
 */
function registryOfPath(registries: readonly PackageRegistry[], path: string): PackageRegistry | undefined {
	let found: { registry: PackageRegistry; length: number } | undefined
	for (const registry of registries) {
		for (const prefix of registryPaths(registry)) {
			if (path.startsWith(prefix) && prefix.length > (found?.length ?? -1)) found = { registry, length: prefix.length }
		}
	}
	return found?.registry
}

/**
 * The proxy package managers in the sandbox reach on `HTTPS_PROXY`, such as `npm ci` and
 * `dotnet restore`. The sandbox has no network, so nothing it tunnels goes out: for the hosts of
 * the app's registries it ends TLS itself, with a certificate from the sandbox's own authority, and
 * answers each `GET` with a fetch through the gateway. Anything else, another host, plain HTTP or a
 * write, is refused here.
 */
export async function startPackageProxy(options: PackageProxyOptions): Promise<PackageProxy> {
	options.abortSignal.throwIfAborted()
	const registriesOfHost = Map.groupBy(options.registries, registryHost)
	const registriesOfSocket = new WeakMap<Socket, readonly PackageRegistry[]>()
	const connections = new Set<Duplex>()

	const serve = async (request: IncomingMessage, response: ServerResponse) => {
		const registries = registriesOfSocket.get(request.socket) ?? []
		const { url } = request
		const registry = url === undefined ? undefined : registryOfPath(registries, url)
		if (url === undefined || registry === undefined) {
			answerPlainly(response, forbidden, 'Not a registry this run restores from.')
			return
		}
		if (request.method !== 'GET') {
			answerPlainly(response, methodNotAllowed, 'Package registries are only read from here.')
			return
		}
		const accept = request.headers.accept
		const asked = PackageRequest.safeParse({ registry, path: url, ...(accept === undefined ? {} : { accept }) })
		if (!asked.success) {
			answerPlainly(response, badRequest, `Not a package fetch: ${url.slice(0, maxEchoedLength)}`)
			return
		}
		const stopped = new AbortController()
		response.once('close', () => {
			stopped.abort(new Error('The package manager went away.'))
		})
		try {
			const fetchAbortSignal = AbortSignal.any([stopped.signal, options.abortSignal])
			const answer = await options.fetchThroughGateway(asked.data, fetchAbortSignal)
			try {
				// Opened before the head goes out, so a body that is gone is a 502 the package manager
				// tries again, not a cut-off response.
				const body = (await open(answer.file)).createReadStream()
				try {
					response.writeHead(answer.status, { ...answer.headers, 'content-length': String(answer.size) })
					await pipeline(body, response, { signal: fetchAbortSignal })
				} finally {
					body.destroy()
				}
			} finally {
				await rm(answer.file, { force: true })
			}
		} catch (error) {
			// A refusal won't pass on another try, and package managers try a 5xx again.
			const refused = error instanceof GatewayCallError && !error.transient
			answerPlainly(response, refused ? forbidden : badGateway, describeError(error))
		}
	}

	const inner = createServer((request, response) => {
		void serve(request, response)
	})
	const outer = createServer((_request, response) => {
		answerPlainly(response, forbidden, 'Only HTTPS to the package registries goes through here.')
	})
	outer.on('connection', (socket) => {
		track(connections, socket)
	})
	outer.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
		// Node leaves the socket without an error listener here: a client that resets it mustn't crash the runtime.
		client.on('error', () => client.destroy())
		const [requestedHost = '', port] = (request.url ?? '').split(':')
		const host = normalizedHost(requestedHost)
		const registries = registriesOfHost.get(host)
		if (registries === undefined || port !== httpsPort) {
			client.end(statusLine(forbidden))
			return
		}
		client.write(statusLine(established))
		if (head.length > 0) client.unshift(head)
		const secure = new TLSSocket(client, { isServer: true, secureContext: options.authority.contextFor(host) })
		secure.on('error', () => secure.destroy())
		track(connections, secure)
		registriesOfSocket.set(secure, registries)
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
	if (typeof address !== 'object' || address === null) {
		outer.close()
		throw new Error('The package proxy has no port to listen on.')
	}
	const { port } = address

	const closed = new AbortController()
	const close = async () => {
		closed.abort()
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
		{ once: true, signal: closed.signal },
	)
	// Stopped while it started listening: the listener above came too late.
	if (options.abortSignal.aborted) {
		await close()
		options.abortSignal.throwIfAborted()
	}
	return Object.freeze({ url: `http://${loopback}:${String(port)}`, close })
}

/** Answers with `status` and `message` as plain text, or drops the response when its headers went out already. */
function answerPlainly(response: ServerResponse, status: number, message: string): void {
	if (response.headersSent) {
		response.destroy()
		return
	}
	response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
	response.end(`${message}\n`)
}

/** Keeps `connection` in `connections` until it closes, so closing the proxy can drop it. */
function track(connections: Set<Duplex>, connection: Duplex): void {
	connections.add(connection)
	connection.once('close', () => connections.delete(connection))
}
