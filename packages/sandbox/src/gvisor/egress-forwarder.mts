import { egressMountPoint } from './layout.mts'

const port = 3128
const socketPath = `${egressMountPoint}/egress.sock`

/**
 * Forwards every connection to `127.0.0.1:<port>` to the egress socket. It runs inside the sandbox
 * as the source of `node -e`, so nothing outside this function is in scope there.
 */
function forward(socket: string, listenPort: number): void {
	const net = process.getBuiltinModule('node:net')
	net
		.createServer((client) => {
			const upstream = net.connect(socket)
			client.on('error', () => upstream.destroy())
			upstream.on('error', () => client.destroy())
			client.pipe(upstream).pipe(client)
		})
		.listen(listenPort, '127.0.0.1')
}

/**
 * The sandbox's init when egress is allowed: the forwarder, so tools that honour `HTTPS_PROXY`
 * reach the allowed hosts. Needs Node 22.3 or later in the image.
 */
export const forwarderInit: readonly string[] = ['node', '-e', `(${forward.toString()})(${JSON.stringify(socketPath)}, ${String(port)})`]

/** What the sandbox's processes need to find the forwarder. Plain HTTP stays blocked. */
export const forwarderEnv: Readonly<Record<string, string>> = {
	HTTPS_PROXY: `http://127.0.0.1:${String(port)}`,
	https_proxy: `http://127.0.0.1:${String(port)}`,
	NO_PROXY: 'localhost,127.0.0.1',
	no_proxy: 'localhost,127.0.0.1',
	NODE_USE_ENV_PROXY: '1',
}
