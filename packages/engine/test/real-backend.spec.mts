import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '@mesh-flow/build'
import { duration } from '@mesh-flow/duration'
import { keyFile, openCredentialStore, openGateway, openProviderSettings } from '@mesh-flow/gateway'
import type { SandboxBackend } from '@mesh-flow/sandbox'
import * as tar from 'tar'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { openAppStore } from '../src/apps/app-store.mts'
import { withPackedApp } from '../src/cli/with-packed-app.mts'
import { Engine } from '../src/engine/engine.mts'
import { finishedStatuses } from '../src/runs/run-record.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { restoredPackage } from './fixtures/restoring-app/restored-package.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { copiedMailbox, deployTestApp, runtimeScript, testAppName, userRun } from './support/test-app.mts'

/**
 * Runs end to end in a real sandbox: one across a shutdown and a restart of the engine, and one
 * that restores a package with npm through the runtime's proxy, with no network. The second builds
 * `fixtures/restoring-app` with `@mesh-flow/core`, so core has to be built first. Opt in, as
 * the sandbox package's conformance suite: `MESH_FLOW_ENGINE_TESTS=gvisor` (with
 * `RUNSC="sudo $(command -v runsc)"` when not root) or `MESH_FLOW_ENGINE_TESTS=microsandbox`.
 */
const backendName = process.env.MESH_FLOW_ENGINE_TESTS
const signal = new AbortController().signal
const deadlines = () => ({ pause: duration.of('1m').toAbortSignal(), backend: duration.of('1m').toAbortSignal() })

/** How long the restore test may take, and its parts: pulling the image is most of it. */
const restoreTimeout = duration.of('5m')
const buildTimeout = duration.of('2m')
const restoredWithin = duration.of('4m')
const pollInterval = duration.of('500ms')

/** Loads only the backend under test, so the other's SDK isn't needed. */
async function openBackend(): Promise<SandboxBackend> {
	if (backendName === 'microsandbox') return (await import('@mesh-flow/sandbox/microsandbox')).microsandboxBackend()
	const { gvisorBackend } = await import('@mesh-flow/sandbox/gvisor')
	return gvisorBackend({
		directory: process.env.MESH_FLOW_GVISOR_DIRECTORY ?? path.join(tmpdir(), 'mesh-flow-gvisor-engine'),
		runsc: (process.env.RUNSC ?? 'runsc').split(' ').filter(Boolean),
	})
}

/** The app in `fixtures/restoring-app`, which runs `npm install` with the real runtime. */
const restoringApp = path.join(import.meta.dirname, 'fixtures', 'restoring-app')

/**
 * What the npm registry would serve for {@link restoredPackage}: its packument, and a tarball laid
 * out as `npm pack` makes it.
 */
async function fakeRegistry(): Promise<Record<string, Response | undefined>> {
	const directory = await temporaryDirectory()
	await mkdir(path.join(directory, 'package'))
	await writeFile(path.join(directory, 'package', 'package.json'), JSON.stringify(restoredPackage))
	const file = path.join(directory, 'package.tgz')
	await tar.create({ gzip: true, cwd: directory, file, portable: true }, ['package'])
	const tarball = await readFile(file)
	const { name, version } = restoredPackage
	const tarballPath = `/${name}/-/${name}-${version}.tgz`
	const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
	const packument = {
		name,
		'dist-tags': { latest: version },
		versions: { [version]: { ...restoredPackage, dist: { tarball: `https://registry.npmjs.org${tarballPath}`, integrity } } },
	}
	return {
		[`/${name}`]: Response.json(packument),
		[tarballPath]: new Response(tarball, { headers: { 'content-type': 'application/octet-stream' } }),
	}
}

const twoQuestions = runtimeScript(
	`
for (const id of ['first', 'second']) {
	mailbox.send({ type: 'request', request: { kind: 'input', id, question: id, fields: {} } })
	const { value } = await mailbox.answer(id, signal)
	event(id, 'answered', { value, pid: process.pid })
}
mailbox.send({ type: 'succeeded' })
`,
	copiedMailbox,
)

describe.runIf(backendName)(`the engine on ${backendName ?? 'a real backend'}`, () => {
	test(
		'runs a workflow across a shutdown and a restart of the engine, in the same process',
		{ timeout: duration.of('5m').to('ms') },
		async () => {
			// Arrange
			const home = await temporaryDirectory()
			const store = () => openRunStore(path.join(home, 'runs'))
			const apps = await openAppStore(path.join(home, 'apps'), signal)
			await deployTestApp(apps, { ask: twoQuestions }, { image: 'node:26-slim', copyMailbox: true })
			const first = await Engine.open({ backend: await openBackend(), store: store(), apps }, signal)
			onTestFinished(() => first.close(deadlines()))
			const { id } = await first.startRun({ ...userRun('ask'), abortSignal: signal })
			await vi.waitFor(
				() => {
					expect(first.get(id).pending).toHaveLength(1)
				},
				{ timeout: duration.of('4m').to('ms'), interval: 500 },
			)
			await first.answer(id, 'first', 1, signal)
			await vi.waitFor(
				() => {
					expect(first.get(id).pending).toEqual([expect.objectContaining({ id: 'second' })])
				},
				{ timeout: duration.of('1m').to('ms'), interval: 500 },
			)
			await first.close(deadlines())

			// Act
			const backend = await openBackend()
			const second = await Engine.open({ backend, store: store(), apps }, signal)
			onTestFinished(() => second.close(deadlines()))
			await second.resume(id, signal)
			await second.answer(id, 'second', 2, signal)
			await vi.waitFor(
				() => {
					expect(second.get(id).status).toBe('succeeded')
				},
				{ timeout: duration.of('1m').to('ms'), interval: 500 },
			)

			// Assert
			const events = await second.events(id)
			expect(events.map((event) => event['value'])).toEqual([1, 2])
			expect(events[0]?.['pid']).toBe(events[1]?.['pid'])
			// The sandbox goes after the outcome is saved.
			await vi.waitFor(async () => {
				expect(await backend.list(signal)).toEqual([])
			}, duration.of('1m').to('ms'))
		},
	)

	test(
		"restores packages with npm through the runtime's proxy, in a sandbox with no network",
		{ timeout: restoreTimeout.to('ms') },
		async () => {
			// Arrange
			const home = await temporaryDirectory()
			const served = await fakeRegistry()
			const fetch = vi.fn<typeof globalThis.fetch>((input) => {
				const { pathname } = new URL(input instanceof Request ? input.url : input)
				return Promise.resolve(served[pathname]?.clone() ?? new Response('{}', { status: 404 }))
			})
			const gatewayHome = path.join(home, 'gateway')
			const gateway = openGateway({
				home: gatewayHome,
				credentials: openCredentialStore(path.join(gatewayHome, 'credentials.json'), keyFile(path.join(gatewayHome, 'store.key'))),
				providers: openProviderSettings(path.join(gatewayHome, 'providers.json')),
				tools: [],
				fetch,
			})
			const apps = await openAppStore(path.join(home, 'apps'), signal)
			const built = path.join(home, 'built')
			await buildApp({ directory: restoringApp, out: built, abortSignal: buildTimeout.toAbortSignal() })
			await withPackedApp(built, (tarball) => apps.deploy(testAppName, tarball, signal), signal)
			const engine = await Engine.open(
				{ backend: await openBackend(), store: openRunStore(path.join(home, 'runs')), apps, gateway },
				signal,
			)
			onTestFinished(() => engine.close(deadlines()))

			// Act
			const { id } = await engine.startRun({ ...userRun('restore'), abortSignal: signal })

			// Assert
			const finished = await vi.waitFor(
				() => {
					const record = engine.get(id)
					if (!finishedStatuses.has(record.status)) throw new Error(`The run is ${record.status}.`)
					return record
				},
				{ timeout: restoredWithin.to('ms'), interval: pollInterval.to('ms') },
			)
			expect(finished.status, finished.error).toBe('succeeded')
			const fetched = fetch.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).pathname)
			expect(fetched).toEqual(expect.arrayContaining(Object.keys(served)))
		},
	)
})
