import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { duration } from '@mesh-flow/duration'
import { onTestFinished } from 'vitest'
import { serveUiFrom } from '../../src/_module/server.mts'
import { accessCookieName } from '../../src/server/ui-access.mts'

/** A fresh directory, removed when the test ends. */
export async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'mesh-flow-ui-'))
	onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }))
	return directory
}

/** The page a test serves instead of the built one. */
export const testPage = '<!doctype html><title>test page</title>'

/** A UI served on a fresh home with no engine, and a stand-in page; closed when the test ends. */
export async function servedUi() {
	const home = await temporaryDirectory()
	const assets = await temporaryDirectory()
	await writeFile(path.join(assets, 'index.html'), testPage)
	const stopping = new AbortController()
	const served = await serveUiFrom(assets, { home, keychain: false, port: 0, open: false, abortSignal: stopping.signal })
	onTestFinished(async () => {
		stopping.abort()
		await served.closed
	})
	const url = new URL(served.url)
	const token = url.searchParams.get('token') ?? ''
	const cookieName = accessCookieName(url.host)
	return { home, served, stopping, url, token, cookieName, cookie: `${cookieName}=${token}` }
}

/** What a request got back. */
export interface Received {
	readonly status: number
	readonly headers: Readonly<Record<string, string | string[] | undefined>>
	readonly body: string
}

/** One request with exactly these headers, `Host` included, which `fetch` doesn't let a caller set. */
export function send(
	url: URL,
	route: string,
	options: {
		readonly method?: string
		readonly headers?: Record<string, string>
		readonly body?: string
		readonly abortSignal?: AbortSignal
	} = {},
): Promise<Received> {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{
				host: url.hostname,
				port: url.port,
				path: route,
				method: options.method ?? 'GET',
				headers: { host: url.host, ...options.headers },
				signal: options.abortSignal ?? duration.of('10s').toAbortSignal(),
			},
			(response) => {
				const chunks: Buffer[] = []
				response.on('data', (chunk: Buffer) => chunks.push(chunk))
				response.on('error', reject)
				response.on('end', () => {
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })
				})
			},
		)
		outgoing.on('error', reject)
		outgoing.end(options.body)
	})
}
