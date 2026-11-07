/**
 * Runs inside the sandbox: requests https://<host>/ for each host on the command line and prints
 * `{ host: status }` as JSON, with '000' for anything that didn't get through.
 *
 * The test transpiles it to JavaScript first. Goes through HTTPS_PROXY when it is set (gVisor),
 * directly otherwise. Run it with
 * `node --use-system-ca`, so a TLS-intercepting proxy (microsandbox) is trusted.
 */
import { request } from 'node:http'
import { connect } from 'node:tls'

function viaProxy(host: string, proxy: URL): Promise<string> {
	return new Promise((resolve) => {
		const fail = () => {
			resolve('000')
		}
		const tunnel = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${host}:443` })
		tunnel.once('connect', (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy()
				fail()
				return
			}
			const secure = connect({ socket, servername: host }, () => {
				secure.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
			})
			secure.setEncoding('utf8')
			secure.once('data', (text: string) => {
				resolve(text.split(' ')[1] ?? '000')
				secure.destroy()
			})
			secure.once('error', fail)
		})
		tunnel.once('error', fail)
		tunnel.setTimeout(10_000, () => {
			tunnel.destroy()
			fail()
		})
		tunnel.end()
	})
}

async function direct(host: string): Promise<string> {
	try {
		const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) })
		// microsandbox's proxy answers a blocked request itself, with this code in the body.
		if (response.status === 403 && (await response.text()).includes('network_policy_denied')) return '000'
		return String(response.status)
	} catch {
		return '000'
	}
}

const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : undefined
const result: Record<string, string> = {}
for (const host of process.argv.slice(2)) result[host] = proxy ? await viaProxy(host, proxy) : await direct(host)
console.log(JSON.stringify(result))
