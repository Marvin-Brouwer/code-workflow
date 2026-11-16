import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import type { PackageRequest, PackageResponse } from '@mesh-flow/protocol'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { startPackageAccess, type PackageEnvironment } from '../src/packages/package-access.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const run = promisify(execFile)

/** A package that isn't on the real npm registry: an install that finds it went through the proxy. */
const fakePackage = { name: 'mesh-flow-proxy-check', version: '1.0.0' }

/** How long a stopped proxy may take to settle while a fetch never does. */
const promptlyMs = 3_000

type Fetch = (request: PackageRequest, abortSignal: AbortSignal) => Promise<PackageResponse>

function answer(status: number, body: string | Buffer, contentType = 'application/json'): PackageResponse {
	return { status, headers: { 'content-type': contentType }, body: Buffer.from(body).toString('base64') }
}

/** Starts the proxy with `fetch` behind it, stopped when the test ends. */
async function proxyWith(fetch: Fetch): Promise<{ environment: PackageEnvironment; stop: AbortController }> {
	const stop = new AbortController()
	const directory = await temporaryDirectory()
	const { proxy, environment } = await startPackageAccess({ registries: ['npm', 'nuget'], fetch, directory, abortSignal: stop.signal })
	onTestFinished(() => proxy.close())
	return { environment, stop }
}

/** The environment of a child process that only knows the proxy: none of the test's own proxy settings. */
function childEnvironment(environment: PackageEnvironment, home: string): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH, HOME: home, npm_config_cache: path.join(home, 'npm-cache'), ...environment }
}

/** A tarball of a package with nothing in it, as `npm pack` makes it, and its packument. */
async function fakeRegistry(): Promise<{ packument: string; tarball: Buffer; tarballPath: string }> {
	const directory = await temporaryDirectory()
	await writeFile(path.join(directory, 'package.json'), JSON.stringify(fakePackage))
	const { stdout } = await run('npm', ['pack', '--silent'], { cwd: directory })
	const tarball = await readFile(path.join(directory, stdout.trim()))
	const tarballPath = `/${fakePackage.name}/-/${fakePackage.name}-${fakePackage.version}.tgz`
	const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
	const packument = JSON.stringify({
		name: fakePackage.name,
		'dist-tags': { latest: fakePackage.version },
		versions: {
			[fakePackage.version]: {
				...fakePackage,
				dist: { tarball: `https://registry.npmjs.org${tarballPath}`, integrity },
			},
		},
	})
	return { packument, tarball, tarballPath }
}

/** Sends a request for `target` through the proxy as a plain-HTTP proxy request, and resolves to its status. */
function plainRequest(proxyUrl: string, target: string, method = 'GET'): Promise<number> {
	const proxy = new URL(proxyUrl)
	return new Promise((resolve, reject) => {
		const sent = request({ host: proxy.hostname, port: proxy.port, path: target, method }, (response) => {
			response.resume()
			resolve(response.statusCode ?? 0)
		})
		sent.once('error', reject)
		sent.end()
	})
}

/**
 * The proxy serves Linux sandboxes. On a Windows host, curl trusts only the system store and npm is
 * `npm.cmd`, so these run on Linux and macOS only.
 */
const onWindows = process.platform === 'win32'

describe.skipIf(onWindows)('package proxy', () => {
	test('npm installs a package through it, from what the gateway fetched', { timeout: 60_000 }, async () => {
		// Arrange
		const { packument, tarball, tarballPath } = await fakeRegistry()
		const fetch = vi.fn<Fetch>((asked) => {
			if (asked.path === `/${fakePackage.name}`) return Promise.resolve(answer(200, packument))
			if (asked.path === tarballPath) return Promise.resolve(answer(200, tarball, 'application/octet-stream'))
			return Promise.resolve(answer(404, '{}'))
		})
		const { environment } = await proxyWith(fetch)
		const project = await temporaryDirectory()
		await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'project', private: true }))

		// Act
		await run('npm', ['install', '--no-audit', '--no-fund', `${fakePackage.name}@${fakePackage.version}`], {
			cwd: project,
			env: childEnvironment(environment, project),
		})

		// Assert
		const installed = JSON.parse(await readFile(path.join(project, 'node_modules', fakePackage.name, 'package.json'), 'utf8')) as unknown
		expect(installed).toMatchObject(fakePackage)
		expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ registry: 'npm', path: tarballPath }), expect.any(AbortSignal))
	})

	test('curl, which trusts what OpenSSL trusts, as .NET does, gets the feed through it', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>(() => Promise.resolve(answer(200, '{"version":"3.0.0"}')))
		const { environment } = await proxyWith(fetch)
		const home = await temporaryDirectory()

		// Act
		const { stdout } = await run('curl', ['--fail', '--silent', '--show-error', 'https://api.nuget.org/v3/index.json'], {
			env: childEnvironment(environment, home),
		})

		// Assert
		expect(JSON.parse(stdout)).toEqual({ version: '3.0.0' })
		expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ registry: 'nuget', path: '/v3/index.json' }), expect.any(AbortSignal))
	})

	test('refuses hosts that are not the registries', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>()
		const { environment } = await proxyWith(fetch)
		const home = await temporaryDirectory()

		// Act
		const curling = run('curl', ['--fail', '--silent', 'https://example.com/'], { env: childEnvironment(environment, home) })

		// Assert
		await expect(curling).rejects.toThrow()
		expect(fetch).not.toHaveBeenCalled()
	})

	test('refuses plain HTTP and writes', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>()
		const { environment } = await proxyWith(fetch)

		// Act
		const plain = await plainRequest(environment.HTTPS_PROXY ?? '', 'http://registry.npmjs.org/left-pad')
		const written = await plainRequest(environment.HTTPS_PROXY ?? '', 'http://registry.npmjs.org/left-pad', 'PUT')

		// Assert
		expect([plain, written]).toEqual([403, 403])
		expect(fetch).not.toHaveBeenCalled()
	})

	test('stops promptly while a fetch never settles', async () => {
		// Arrange
		let fetchSignal: AbortSignal | undefined
		const fetch = vi.fn<Fetch>((_request, abortSignal) => {
			fetchSignal = abortSignal
			return new Promise<PackageResponse>(() => undefined)
		})
		const { environment, stop } = await proxyWith(fetch)
		const home = await temporaryDirectory()
		const curling = run('curl', ['--silent', 'https://registry.npmjs.org/left-pad'], { env: childEnvironment(environment, home) })
		curling.catch(() => undefined)
		await vi.waitFor(() => {
			expect(fetch).toHaveBeenCalled()
		})

		// Act
		const started = Date.now()
		stop.abort(new Error('The run stopped.'))
		await curling.catch(() => undefined)

		// Assert
		expect(fetchSignal?.aborted).toBe(true)
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})
})

describe('package access', () => {
	test('writes the authority it trusts where the environment says', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(directory, { recursive: true })
		const stop = new AbortController()

		// Act
		const { proxy, environment } = await startPackageAccess({
			registries: ['npm'],
			fetch: vi.fn<Fetch>(),
			directory,
			abortSignal: stop.signal,
		})
		onTestFinished(() => proxy.close())

		// Assert
		expect(environment.NODE_EXTRA_CA_CERTS).toBe(environment.SSL_CERT_FILE)
		expect(await readFile(environment.SSL_CERT_FILE ?? '', 'utf8')).toContain('BEGIN CERTIFICATE')
		expect(environment.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
	})
})
