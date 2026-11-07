import { egressMountPoint } from './layout.mts'

const port = 3128

/**
 * Runs inside the sandbox as its init when egress is allowed: forwards `127.0.0.1:3128` to the
 * egress socket, so tools that honour `HTTPS_PROXY` reach the allowed hosts. Needs `node` in the
 * image.
 */
export const forwarderInit: readonly string[] = [
	'node',
	'-e',
	`const net = require('node:net');
net.createServer((client) => {
    const upstream = net.connect('${egressMountPoint}/egress.sock');
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream).pipe(client);
}).listen(${String(port)}, '127.0.0.1');`,
]

/** What the sandbox's processes need to find the forwarder. Plain HTTP stays blocked. */
export const forwarderEnv: Readonly<Record<string, string>> = {
	HTTPS_PROXY: `http://127.0.0.1:${String(port)}`,
	https_proxy: `http://127.0.0.1:${String(port)}`,
	NO_PROXY: 'localhost,127.0.0.1',
	no_proxy: 'localhost,127.0.0.1',
	NODE_USE_ENV_PROXY: '1',
}
