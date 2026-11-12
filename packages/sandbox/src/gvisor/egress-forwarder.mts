import { egressMountPoint } from './layout.mts'

const port = 3128
const egressSocket = `${egressMountPoint}/egress.sock`

/**
 * Forwards every connection to `127.0.0.1:<port>` to the egress socket. It runs inside the sandbox
 * as the source of `node -e`, so nothing outside this function is in scope there: no imports and
 * no helpers, which a bundler could rename. It only uses its arguments and Node's globals.
 */
function forward(socketPath: string, listenPort: number): void {
	const net = process.getBuiltinModule('node:net')
	net
		.createServer((client) => {
			const upstream = net.connect(socketPath)
			client.on('error', () => upstream.destroy())
			upstream.on('error', () => client.destroy())
			client.pipe(upstream).pipe(client)
		})
		.listen(listenPort, '127.0.0.1')
}

/**
 * The service init starts when egress is allowed: the forwarder, so tools that honour `HTTPS_PROXY`
 * reach the allowed hosts. Needs Node 22.3 or later in the image.
 */
export const forwarderService: readonly string[] = [
	'node',
	'-e',
	`(${forward.toString()})(${JSON.stringify(egressSocket)}, ${String(port)})`,
]

/**
 * Waits in the sandbox, up to `timeoutMs`, until the forwarder takes connections, then exits 0;
 * exits 1 when it never does. Like {@link forward}, it runs as the source of `node -e`.
 */
function waitForForwarder(listenPort: number, timeoutMs: number): void {
	const net = process.getBuiltinModule('node:net')
	const deadline = Date.now() + timeoutMs
	const attempt = () => {
		const socket = net.connect(listenPort, '127.0.0.1', () => {
			socket.destroy()
			process.exit(0)
		})
		socket.on('error', () => {
			if (Date.now() > deadline) process.exit(1)
			setTimeout(attempt, 20)
		})
	}
	attempt()
}

/**
 * Exits 0 once the forwarder listens. Init starts the forwarder in the background, so without this
 * a command run straight after create can find nothing on the port, which a tool without retries,
 * such as curl, gives up on.
 */
export const forwarderReady: readonly string[] = ['node', '-e', `(${waitForForwarder.toString()})(${String(port)}, 10000)`]

/** What the sandbox's processes need to find the forwarder. Plain HTTP stays blocked. */
export const forwarderEnv: Readonly<Record<string, string>> = {
	HTTPS_PROXY: `http://127.0.0.1:${String(port)}`,
	https_proxy: `http://127.0.0.1:${String(port)}`,
	NO_PROXY: 'localhost,127.0.0.1',
	no_proxy: 'localhost,127.0.0.1',
	NODE_USE_ENV_PROXY: '1',
}
