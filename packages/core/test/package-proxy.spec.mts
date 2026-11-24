import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { duration } from '@mesh-flow/duration'
import { keyFile, openCredentialStore, openGateway } from '@mesh-flow/gateway'
import type { ConnectorRegistry, PackageRegistry, PackageRequest } from '@mesh-flow/protocol'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { gatewayClient, GatewayCallError } from '../src/gateway/gateway-client.mts'
import { packageFetchThroughGateway, type GatewayFetch } from '../src/gateway/gateway-packages.mts'
import { startPackageAccess, type PackageEnvironment } from '../src/packages/package-access.mts'
import { gatewayChannel } from './support/gateway-channel.mts'
import { npmRegistry, nugetOrg } from './support/registries.mts'
import { storedZip } from './support/stored-zip.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const run = promisify(execFile)

/** A package that isn't on the real npm registry: an install that finds it went through the proxy. */
const fakeNpmPackage = { name: 'mesh-flow-proxy-check', version: '1.0.0' }

/** A package that isn't on nuget.org: a restore that finds it went through the proxy. */
const fakeNuGetPackage = { id: 'MeshFlow.ProxyCheck', version: '1.0.0' }

/** The .NET SDK's major version on this machine, or `undefined` without one. */
function dotnetSdkMajor(): string | undefined {
	const result = spawnSync('dotnet', ['--version'], { encoding: 'utf8' })
	if (result.error !== undefined) return undefined
	return /^(\d+)\./.exec(result.stdout)?.[1]
}

const dotnetMajor = dotnetSdkMajor()

/** How long a first `dotnet restore` may take: the SDK sets itself up on its first run. */
const restoreTimeout = duration.of('2m')

/** How long a stopped proxy may take to settle while a fetch never does. */
const promptly = duration.of('3s')

/** What the gateway answers in these tests, before the engine stages its body. */
interface Answered {
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly body: Buffer
}

type Fetch = (request: PackageRequest, abortSignal: AbortSignal) => Promise<Answered>

function answer(status: number, body: string | Buffer, contentType = 'application/json'): Answered {
	return { status, headers: { 'content-type': contentType }, body: Buffer.from(body) }
}

/** A connector's registry with two repositories on one host, as CodeArtifact has them. */
function connectorRegistry(repository: string): ConnectorRegistry {
	return {
		connector: 'cloud',
		name: `cloud ${repository}`,
		host: 'packages.example.com',
		paths: [`/npm/${repository}/`],
		settings: { repository },
	}
}

/**
 * A real gateway, in this process, for a run that restores from `registries`, fetching from the
 * host with `fetchFromHost`: what the proxy calls for each fetch, with the gateway's own checks.
 */
async function throughGateway(registries: readonly PackageRegistry[], fetchFromHost: typeof fetch): Promise<GatewayFetch> {
	const home = await temporaryDirectory()
	const gateway = openGateway({
		home,
		credentials: openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key'))),
		fetch: fetchFromHost,
	})
	const lifetime = new AbortController()
	onTestFinished(() => {
		lifetime.abort()
	})
	const grant = await gateway.openRun('run-1', { tools: [], registries }, lifetime.signal)
	return packageFetchThroughGateway(gatewayClient(gatewayChannel(gateway, 'run-1', lifetime.signal), grant, 'test', lifetime.signal))
}

/**
 * Starts the proxy with `fetch` behind it, stopped when the test ends. Each answer's body is staged
 * in `staging` first, as the engine does.
 */
async function proxyWith(
	fetch: Fetch,
	registries: readonly PackageRegistry[] = [npmRegistry, nugetOrg],
): Promise<{ environment: PackageEnvironment; stop: AbortController; staging: string }> {
	const staging = await temporaryDirectory()
	let staged = 0
	const fetchStaged: GatewayFetch = async (asked, abortSignal) => {
		const answered = await fetch(asked, abortSignal)
		const file = path.join(staging, `call-${String(++staged)}.body`)
		await writeFile(file, answered.body)
		return { status: answered.status, headers: answered.headers, file, size: answered.body.length }
	}
	return { ...(await proxyOver(fetchStaged, registries)), staging }
}

/** Starts the proxy with `fetchStaged` behind it, stopped when the test ends. */
async function proxyOver(
	fetchStaged: GatewayFetch,
	registries: readonly PackageRegistry[] = [npmRegistry, nugetOrg],
): Promise<{ environment: PackageEnvironment; stop: AbortController }> {
	const stop = new AbortController()
	const directory = await temporaryDirectory()
	const { proxy, environment } = await startPackageAccess({ registries, fetchStaged, directory, abortSignal: stop.signal })
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
	await writeFile(path.join(directory, 'package.json'), JSON.stringify(fakeNpmPackage))
	const { stdout } = await run('npm', ['pack', '--silent'], { cwd: directory })
	const tarball = await readFile(path.join(directory, stdout.trim()))
	const tarballPath = `/${fakeNpmPackage.name}/-/${fakeNpmPackage.name}-${fakeNpmPackage.version}.tgz`
	const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
	const packument = JSON.stringify({
		name: fakeNpmPackage.name,
		'dist-tags': { latest: fakeNpmPackage.version },
		versions: {
			[fakeNpmPackage.version]: {
				...fakeNpmPackage,
				dist: { tarball: `https://registry.npmjs.org${tarballPath}`, integrity },
			},
		},
	})
	return { packument, tarball, tarballPath }
}

/**
 * Runs curl with `args` through the proxy, and resolves to the status it got. When curl got none,
 * it resolves to curl's exit code and error instead, so a failing test names why.
 */
async function curlStatus(environment: PackageEnvironment, home: string, commandArguments: readonly string[]): Promise<string> {
	// curl exits 0 on any status it got; without one, it exits with why. Async: the proxy runs in this process.
	const curled = await new Promise<{ stdout: string; stderr: string; failure: string | undefined }>((resolve) => {
		execFile(
			'curl',
			['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', ...commandArguments],
			{ env: childEnvironment(environment, home) },
			(error, stdout, stderr) => {
				resolve({ stdout, stderr, failure: error === null ? undefined : String(error.code) })
			},
		)
	})
	const status = curled.stdout.trim()
	if (status !== '' && status !== '000') return status
	return `no status: curl exited ${curled.failure ?? '0'}: ${curled.stderr.trim()}`
}

/** A path longer than a package fetch may be. */
const tooLongPath = `/left-pad?${'a'.repeat(4096)}`

/**
 * What nuget.org's v3 feed would serve for {@link fakeNuGetPackage}: the service index, the flat
 * container's version list, the package and its nuspec, by path.
 */
/** Where the fake feed's vulnerability data is: below `/v3-vulnerabilities/`, as on nuget.org. */
const vulnerabilityData = 'https://api.nuget.org/v3-vulnerabilities/2026.11.16.00.00.00/vulnerability.base.json'

function fakeNuGetFeed(): Record<string, Answered> {
	const { id, version } = fakeNuGetPackage
	const lowerId = id.toLowerCase()
	const nuspec = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
	<metadata>
		<id>${id}</id>
		<version>${version}</version>
		<authors>mesh-flow</authors>
		<description>Checks a restore through the package proxy.</description>
	</metadata>
</package>
`
	const flatContainer = `/v3-flatcontainer/${lowerId}`
	return {
		'/v3/index.json': answer(
			200,
			JSON.stringify({
				version: '3.0.0',
				resources: [
					{ '@id': 'https://api.nuget.org/v3-flatcontainer/', '@type': 'PackageBaseAddress/3.0.0' },
					{ '@id': 'https://api.nuget.org/v3/vulnerabilities/index.json', '@type': 'VulnerabilityInfo/6.7.0' },
				],
			}),
		),
		'/v3/vulnerabilities/index.json': answer(
			200,
			JSON.stringify([{ '@name': 'base', '@id': vulnerabilityData, '@updated': '2026-11-16T00:00:00Z', comment: 'None known.' }]),
		),
		[new URL(vulnerabilityData).pathname]: answer(200, '{}'),
		[`${flatContainer}/index.json`]: answer(200, JSON.stringify({ versions: [version] })),
		[`${flatContainer}/${version}/${lowerId}.nuspec`]: answer(200, nuspec, 'application/xml'),
		[`${flatContainer}/${version}/${lowerId}.${version}.nupkg`]: answer(
			200,
			storedZip({ [`${id}.nuspec`]: nuspec }),
			'application/octet-stream',
		),
	}
}

/** A project that references {@link fakeNuGetPackage}, restoring from nuget.org only. */
async function restoringProject(): Promise<string> {
	const project = await temporaryDirectory()
	const { id, version } = fakeNuGetPackage
	await writeFile(
		path.join(project, 'Project.csproj'),
		`<Project Sdk="Microsoft.NET.Sdk">
	<PropertyGroup>
		<TargetFramework>net${dotnetMajor ?? ''}.0</TargetFramework>
	</PropertyGroup>
	<ItemGroup>
		<PackageReference Include="${id}" Version="${version}" />
	</ItemGroup>
</Project>
`,
	)
	await writeFile(
		path.join(project, 'nuget.config'),
		`<?xml version="1.0" encoding="utf-8"?>
<configuration>
	<packageSources>
		<clear />
		<add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
	</packageSources>
</configuration>
`,
	)
	return project
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

describe.skipIf(onWindows)('package proxy', { repeats: 15 }, () => {
	test('npm installs a package through it, from what the gateway fetched', { timeout: duration.of('1m').to('ms') }, async () => {
		// Arrange
		const { packument, tarball, tarballPath } = await fakeRegistry()
		const fetch = vi.fn<Fetch>((asked) => {
			if (asked.path === `/${fakeNpmPackage.name}`) return Promise.resolve(answer(200, packument))
			if (asked.path === tarballPath) return Promise.resolve(answer(200, tarball, 'application/octet-stream'))
			return Promise.resolve(answer(404, '{}'))
		})
		const { environment } = await proxyWith(fetch)
		const project = await temporaryDirectory()
		await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'project', private: true }))

		// Act
		await run('npm', ['install', '--no-audit', '--no-fund', `${fakeNpmPackage.name}@${fakeNpmPackage.version}`], {
			cwd: project,
			env: childEnvironment(environment, project),
		})

		// Assert
		const installed = JSON.parse(await readFile(path.join(project, 'node_modules', fakeNpmPackage.name, 'package.json'), 'utf8')) as unknown
		expect(installed).toMatchObject(fakeNpmPackage)
		expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ registry: npmRegistry, path: tarballPath }), expect.any(AbortSignal))
	})

	// .NET reads SSL_CERT_FILE on Linux only; on macOS it trusts the keychain. CI's Linux runners have the SDK.
	test.runIf(process.platform === 'linux' && (dotnetMajor !== undefined || process.env.CI === 'true'))(
		'dotnet restores a package through it, from what the gateway fetched',
		{ timeout: restoreTimeout.to('ms') },
		async () => {
			// Arrange
			const feed = fakeNuGetFeed()
			const fromNuGet = vi.fn<typeof globalThis.fetch>((input) => {
				const asked = feed[new URL(input instanceof Request ? input.url : input.toString()).pathname]
				return Promise.resolve(
					asked === undefined
						? new Response('{}', { status: 404 })
						: new Response(asked.body, { status: asked.status, headers: asked.headers }),
				)
			})
			const { environment } = await proxyOver(await throughGateway([nugetOrg], fromNuGet))
			const project = await restoringProject()
			const packages = path.join(project, 'packages')

			// Act
			await run('dotnet', ['restore'], {
				cwd: project,
				env: {
					...childEnvironment(environment, project),
					DOTNET_CLI_HOME: project,
					DOTNET_CLI_TELEMETRY_OPTOUT: '1',
					DOTNET_NOLOGO: '1',
					DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
					NUGET_PACKAGES: packages,
				},
			})

			// Assert
			const { id, version } = fakeNuGetPackage
			const restored = await readFile(path.join(packages, id.toLowerCase(), version, `${id.toLowerCase()}.nuspec`), 'utf8')
			expect(restored).toContain(`<id>${id}</id>`)
			const fetched = fromNuGet.mock.calls.map(([input]) => (input instanceof Request ? input.url : input.toString()))
			expect(fetched).toEqual(
				expect.arrayContaining([
					`https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/${version}/${id.toLowerCase()}.${version}.nupkg`,
					vulnerabilityData,
				]),
			)
		},
	)

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
		expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ registry: nugetOrg, path: '/v3/index.json' }), expect.any(AbortSignal))
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

	test('refuses plain HTTP, reads and writes alike', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>()
		const { environment } = await proxyWith(fetch)

		// Act
		const plain = await plainRequest(environment.HTTPS_PROXY, 'http://registry.npmjs.org/left-pad')
		const written = await plainRequest(environment.HTTPS_PROXY, 'http://registry.npmjs.org/left-pad', 'PUT')

		// Assert
		expect([plain, written]).toEqual([403, 403])
		expect(fetch).not.toHaveBeenCalled()
	})

	test('refuses a write over HTTPS, and anything but a read', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>()
		const { environment } = await proxyWith(fetch)
		const home = await temporaryDirectory()

		// Act
		const written = await curlStatus(environment, home, ['--request', 'PUT', 'https://registry.npmjs.org/left-pad'])
		const head = await curlStatus(environment, home, ['--head', 'https://registry.npmjs.org/left-pad'])

		// Assert
		expect([written, head]).toEqual(['405', '405'])
		expect(fetch).not.toHaveBeenCalled()
	})

	test("refuses a path the registry excludes, such as the npm registry's own API, and sends nothing", async () => {
		// Arrange
		const fetch = vi.fn<Fetch>()
		const { environment } = await proxyWith(fetch)
		const home = await temporaryDirectory()

		// Act
		const answered = await curlStatus(environment, home, ['https://registry.npmjs.org/-/whoami'])

		// Assert
		expect(answered).toBe('403')
		expect(fetch).not.toHaveBeenCalled()
	})

	test.each([
		["403 to a fetch the gateway refused, which another try won't change", new GatewayCallError('Not a package fetch.'), '403'],
		['502 to a fetch that failed for now', new GatewayCallError('npm is down.', { transient: true }), '502'],
	])('answers %s', async (_what, error, status) => {
		// Arrange
		const fetch = vi.fn<Fetch>(() => Promise.reject(error))
		const { environment } = await proxyWith(fetch)
		const home = await temporaryDirectory()

		// Act
		const answered = await curlStatus(environment, home, ['https://registry.npmjs.org/left-pad'])

		// Assert
		expect(answered).toBe(status)
	})

	test('answers 403 to a path the gateway refuses, and 502 when the host cannot reach the registry', async () => {
		// Arrange
		const unreachable = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new TypeError('fetch failed')))
		const { environment } = await proxyOver(await throughGateway([npmRegistry], unreachable))
		const home = await temporaryDirectory()

		// Act
		const refused = await curlStatus(environment, home, ['https://registry.npmjs.org/-/whoami'])
		const failed = await curlStatus(environment, home, ['https://registry.npmjs.org/left-pad'])

		// Assert
		expect([refused, failed]).toEqual(['403', '502'])
	})

	test("answers 400 to a fetch the gateway couldn't take, and sends nothing", async () => {
		// Arrange
		const fetch = vi.fn<Fetch>()
		const { environment } = await proxyWith(fetch)
		const home = await temporaryDirectory()

		// Act
		const status = await curlStatus(environment, home, [`https://registry.npmjs.org${tooLongPath}`])

		// Assert
		expect(status).toBe('400')
		expect(fetch).not.toHaveBeenCalled()
	})

	test('takes a registry host in any case, and with a trailing dot', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>(() => Promise.resolve(answer(200, '{}')))
		const { environment } = await proxyWith(fetch)
		const home = await temporaryDirectory()

		// Act
		const status = await curlStatus(environment, home, ['https://Registry.NPMJS.org./left-pad'])

		// Assert
		expect(status).toBe('200')
		expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ registry: npmRegistry, path: '/left-pad' }), expect.any(AbortSignal))
	})

	test('keeps serving when a client resets a refused tunnel', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>(() => Promise.resolve(answer(200, '{}')))
		const { environment } = await proxyWith(fetch)
		const proxy = new URL(environment.HTTPS_PROXY)
		const home = await temporaryDirectory()
		const socket = connect(Number(proxy.port), proxy.hostname)
		await new Promise((resolve) => socket.once('connect', resolve))

		// Act: whether the reset lands while the proxy writes its 403 is up to timing, so this shows
		// the proxy survives; without its error listener the reset failed this test as an unhandled error.
		socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
		socket.resetAndDestroy()
		const status = await curlStatus(environment, home, ['https://registry.npmjs.org/left-pad'])

		// Assert
		expect(status).toBe('200')
	})

	test('sends a fetch on a shared host to the registry whose path it is on, and refuses other paths', async () => {
		// Arrange
		const fetch = vi.fn<Fetch>(() => Promise.resolve(answer(200, '{}')))
		const { environment } = await proxyWith(fetch, [connectorRegistry('one'), connectorRegistry('two')])
		const home = await temporaryDirectory()

		// Act
		const two = await curlStatus(environment, home, ['https://packages.example.com/npm/two/left-pad'])
		const elsewhere = await curlStatus(environment, home, ['https://packages.example.com/npm/three/left-pad'])

		// Assert
		expect([two, elsewhere]).toEqual(['200', '403'])
		expect(fetch.mock.calls.map(([asked]) => [asked.registry, asked.path])).toEqual([[connectorRegistry('two'), '/npm/two/left-pad']])
	})

	test('serves the staged body as it is and removes it once it sent it', async () => {
		// Arrange
		const body = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte))
		const fetch = vi.fn<Fetch>(() => Promise.resolve(answer(200, body, 'application/octet-stream')))
		const { environment, staging } = await proxyWith(fetch)
		const home = await temporaryDirectory()
		const saved = path.join(home, 'saved.tgz')

		// Act
		await run('curl', ['--fail', '--silent', '--output', saved, 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'], {
			env: childEnvironment(environment, home),
		})

		// Assert
		expect(await readFile(saved)).toEqual(body)
		await vi.waitFor(async () => {
			expect(await readdir(staging)).toEqual([])
		})
	})

	test('answers 502 when the staged body is gone before it was sent, so the package manager tries again', async () => {
		// Arrange
		const staging = await temporaryDirectory()
		const gone = path.join(staging, 'gone.body')
		const { environment } = await proxyOver(() => Promise.resolve({ status: 200, headers: {}, file: gone, size: 1 }))
		const home = await temporaryDirectory()

		// Act
		const answered = await curlStatus(environment, home, ['https://registry.npmjs.org/left-pad'])

		// Assert
		expect(answered).toBe('502')
	})

	test('stops promptly while a fetch never settles', async () => {
		// Arrange
		let fetchSignal: AbortSignal | undefined
		const fetch = vi.fn<Fetch>((_request, abortSignal) => {
			fetchSignal = abortSignal
			return new Promise<Answered>(() => undefined)
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
		expect(Date.now() - started).toBeLessThan(promptly.to('ms'))
	})
})

describe('package access', () => {
	test('writes the authority it trusts where the environment says', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const stop = new AbortController()

		// Act
		const { proxy, environment } = await startPackageAccess({
			registries: [npmRegistry],
			fetchStaged: vi.fn<GatewayFetch>(),
			directory,
			abortSignal: stop.signal,
		})
		onTestFinished(() => proxy.close())

		// Assert
		expect(environment.NODE_EXTRA_CA_CERTS).toBe(environment.SSL_CERT_FILE)
		expect(await readFile(environment.SSL_CERT_FILE, 'utf8')).toContain('BEGIN CERTIFICATE')
		expect(environment.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
	})

	test('throws on a signal that is aborted already', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const reason = new Error('The run stopped.')

		// Act
		const starting = startPackageAccess({
			registries: [npmRegistry],
			fetchStaged: vi.fn<GatewayFetch>(),
			directory,
			abortSignal: AbortSignal.abort(reason),
		})

		// Assert
		await expect(starting).rejects.toBe(reason)
	})
})
