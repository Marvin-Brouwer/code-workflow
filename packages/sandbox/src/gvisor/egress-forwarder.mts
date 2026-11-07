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

/** What the sandbox's processes need to find the forwarder. Plain HTTP stays blocked. */
export const forwarderEnv: Readonly<Record<string, string>> = {
	HTTPS_PROXY: `http://127.0.0.1:${String(port)}`,
	https_proxy: `http://127.0.0.1:${String(port)}`,
	NO_PROXY: 'localhost,127.0.0.1',
	no_proxy: 'localhost,127.0.0.1',
	NODE_USE_ENV_PROXY: '1',
}
