/**
 * Runs inside the sandbox: requests https://<host>/ for each host on the command line and prints
 * `{ hosts: { host: status }, loopback }` as JSON, with '000' for a host that didn't get through,
 * and in `loopback` whether loopback works, which the runtime's package proxy needs.
 *
 * The test transpiles it to JavaScript first.
 */
import { createServer, request } from 'node:http'

/** What a host that didn't answer gets, as curl prints it. */
const unreachable = '000'

/** The loopback address, which the proxy listens on. */
const loopbackHost = '127.0.0.1'

/** How long a probe waits for an answer: in milliseconds, since this runs in the sandbox without the workspace's packages. */
const answerWithin = 10_000

async function status(host: string): Promise<string> {
	try {
		const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(answerWithin) })
		return String(response.status)
	} catch {
		return unreachable
	}
}

function loopback(): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((_request, response) => response.end('ok'))
		server.listen(0, loopbackHost, () => {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			const asked = request({ host: loopbackHost, port, path: '/' }, (response) => {
				response.setEncoding('utf8')
				let body = ''
				response.on('data', (chunk: string) => (body += chunk))
				response.on('end', () => {
					server.close()
					resolve(body)
				})
			})
			asked.once('error', () => {
				server.close()
				resolve(unreachable)
			})
			asked.end()
		})
	})
}

const hosts: Record<string, string> = {}
for (const host of process.argv.slice(2)) hosts[host] = await status(host)
console.log(JSON.stringify({ hosts, loopback: await loopback() }))
