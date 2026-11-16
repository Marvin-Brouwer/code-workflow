/**
 * Runs inside the sandbox: requests https://<host>/ for each host on the command line and prints
 * `{ host: status }` as JSON, with '000' for anything that didn't get through. Then it checks that
 * loopback works, which the runtime's package proxy needs, and prints it as `loopback`.
 *
 * The test transpiles it to JavaScript first.
 */
import { createServer, request } from 'node:http'

async function status(host: string): Promise<string> {
	try {
		const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) })
		return String(response.status)
	} catch {
		return '000'
	}
}

function loopback(): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((_request, response) => response.end('ok'))
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			const asked = request({ host: '127.0.0.1', port, path: '/' }, (response) => {
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
				resolve('000')
			})
			asked.end()
		})
	})
}

const result: Record<string, string> = {}
for (const host of process.argv.slice(2)) result[host] = await status(host)
result.loopback = await loopback()
console.log(JSON.stringify(result))
