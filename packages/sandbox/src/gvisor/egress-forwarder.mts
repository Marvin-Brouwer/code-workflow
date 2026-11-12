import { egressMountPoint } from './layout.mts'

const listenPort = 3128
/** Where the forwarder listens, inside the sandbox. */
const listenHost = '127.0.0.1'
const egressSocket = `${egressMountPoint}/egress.sock`

/** Source for `node -e` that calls `fn` with `args`, written as JSON. */
function sourceOf<Args extends readonly (string | number)[]>(fn: (...args: Args) => void, ...args: Args): string {
	return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(', ')})`
}

/**
 * Forwards every connection to `host:port` to the egress socket. It runs inside the sandbox
 * as the source of `node -e`, so nothing outside this function is in scope there: no imports and
 * no helpers, which a bundler could rename. It only uses its arguments and Node's globals.
 */
function forward(socketPath: string, host: string, port: number): void {
	const net = process.getBuiltinModule('node:net')
	net
		.createServer((client) => {
			const upstream = net.connect(socketPath)
			client.on('error', () => upstream.destroy())
			upstream.on('error', () => client.destroy())
			client.pipe(upstream).pipe(client)
		})
		.listen(port, host)
}

/**
 * The service init starts when egress is allowed: the forwarder, so tools that honour `HTTPS_PROXY`
 * reach the allowed hosts. Needs Node 22.3 or later in the image.
 */
export const forwarderService: readonly string[] = ['node', '-e', sourceOf(forward, egressSocket, listenHost, listenPort)]

/**
 * How long create waits for the forwarder to listen. Init starts it in the background, and a
 * cold start of node on a loaded machine can take seconds; create's own signal still bounds it.
 */
const forwarderStartTimeoutMs = 30_000

/** How often the wait tries to connect. */
const forwarderRetryMs = 20

/**
 * Exits 0 once something listens on `host:port`, or 1 with a message after `timeoutMs`.
 * Like {@link forward}, it runs as the source of `node -e`.
 */
function waitForForwarder(host: string, port: number, timeoutMs: number, retryMs: number): void {
	const net = process.getBuiltinModule('node:net')
	const deadline = Date.now() + timeoutMs
	const attempt = () => {
		const socket = net.connect(port, host, () => {
			socket.destroy()
			process.exit(0)
		})
		socket.on('error', () => {
			if (Date.now() < deadline) {
				setTimeout(attempt, retryMs)
				return
			}
			process.stderr.write(`The egress forwarder did not listen on ${host}:${String(port)} within ${String(timeoutMs)} ms.\n`)
			process.exit(1)
		})
	}
	attempt()
}

/**
 * The command create runs once the sandbox is up: it returns when the forwarder listens. Without
 * it, a command run straight after create can find nothing on the port, which a tool without
 * retries, such as curl, gives up on.
 */
export const forwarderReadyCheck: readonly string[] = [
	'node',
	'-e',
	sourceOf(waitForForwarder, listenHost, listenPort, forwarderStartTimeoutMs, forwarderRetryMs),
]

/** What the sandbox's processes need to find the forwarder. Plain HTTP stays blocked. */
export const forwarderEnv: Readonly<Record<string, string>> = {
	HTTPS_PROXY: `http://${listenHost}:${String(listenPort)}`,
	https_proxy: `http://${listenHost}:${String(listenPort)}`,
	NO_PROXY: `localhost,${listenHost}`,
	no_proxy: `localhost,${listenHost}`,
	NODE_USE_ENV_PROXY: '1',
}
