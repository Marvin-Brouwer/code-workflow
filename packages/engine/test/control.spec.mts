import path from 'node:path'
import { duration } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { main } from '../src/cli/main.mts'
import { withPackedApp } from '../src/cli/with-packed-app.mts'
import type { LoadedConnector } from '../src/connectors/load-connectors.mts'
import { controlClient, type ControlClient } from '../src/control/control-client.mts'
import { serveEngine } from '../src/serve/serve-engine.mts'
import { hostBackend, hostSandboxLayout } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { builtApp, deployThroughApi, runtimeScript, userRun } from './support/test-app.mts'

const signal = new AbortController().signal

async function serve(connectors: readonly LoadedConnector[] = []) {
	const home = await temporaryDirectory()
	const served = await serveEngine({
		keychain: false,
		connectors: () => Promise.resolve(connectors),
		home,
		backend: hostBackend(path.join(home, 'sandboxes')),
		layout: hostSandboxLayout,
		abortSignal: signal,
	})
	onTestFinished(() => served.close({ pause: duration.of('5s').toAbortSignal(), backend: duration.of('10s').toAbortSignal() }))
	const client = controlClient(served.socketPath)
	return { client, home, served }
}

const ask = runtimeScript(`
mailbox.send({ type: 'request', request: { kind: 'input', id: 'story', question: 'Which story?', fields: {} } })
const { value } = await mailbox.answer('story', signal)
event('answered', 'input-answered', { value })
mailbox.send({ type: 'succeeded' })
`)

describe.skipIf(process.platform !== 'linux')('the control API', () => {
	test('starts a run, answers its request and shows its events', async () => {
		// Arrange
		const { client } = await serve()
		await deployThroughApi(client, { ask })

		// Act
		const started = await client.startRun({ ...userRun('ask'), abortSignal: signal })
		await vi.waitFor(async () => {
			expect((await client.get(started.id, signal)).pending).toHaveLength(1)
		}, duration.of('20s').to('ms'))
		await client.answer(started.id, 'story', 'ABC-1', signal)
		await vi.waitFor(async () => {
			expect((await client.get(started.id, signal)).status).toBe('succeeded')
		}, duration.of('20s').to('ms'))

		// Assert
		expect(await client.list(signal)).toEqual([expect.objectContaining({ id: started.id, workflow: 'ask' })])
		expect(await client.events(started.id, signal)).toEqual([expect.objectContaining({ type: 'input-answered', value: 'ABC-1' })])
	})

	test('deploys an app, as the same version when the tarball is the same, and shows it', async () => {
		// Arrange
		const { client } = await serve()
		const folder = await builtApp({ ask })

		// Act
		const [deployed, again] = await withPackedApp(
			folder,
			async (tarball) => [await client.deploy(tarball, signal), await client.deploy(tarball, signal)],
			signal,
		)
		const shownApp = await client.app(signal)
		const stillMissing = await client.missingSettings(signal)

		// Assert
		expect(again.version).toBe(deployed.version)
		const { missing, ...shown } = deployed
		expect(shownApp).toEqual(shown)
		expect(missing).toEqual([])
		expect(stillMissing).toEqual([])
		expect(deployed.manifest.description.triggers).toEqual([{ kind: 'user', id: 'ask', workflow: 'ask' }])
	})

	test('shows no app before the first deploy', async () => {
		// Arrange
		const { client } = await serve()

		// Act
		const shown = await client.app(signal)

		// Assert
		expect(shown).toBeUndefined()
	})

	test('streams which run changed, and closes with the stream still open', async () => {
		// Arrange
		const { client, served } = await serve()
		await deployThroughApi(client, { ask })
		const changes = await client.followEngine(signal)
		let text = ''
		changes.on('data', (chunk: Buffer) => {
			text += chunk.toString('utf8')
		})

		// Act
		const started = await client.startRun({ ...userRun('ask'), abortSignal: signal })
		await vi.waitFor(() => {
			expect(text).toContain(`event: run\ndata: {"id":"${started.id}"}`)
		}, duration.of('20s').to('ms'))
		const closing = served.close({ pause: duration.of('5s').toAbortSignal(), backend: duration.of('10s').toAbortSignal() })

		// Assert
		await expect(closing).resolves.toBeUndefined()
		expect(text.startsWith('event: ready\n')).toBe(true)
	})

	test('streams one run as it goes, and closes with the stream still open', async () => {
		// Arrange
		const { client, served } = await serve()
		await deployThroughApi(client, { ask })
		const started = await client.startRun({ ...userRun('ask'), abortSignal: signal })
		const stream = await client.followRun(started.id, { abortSignal: signal })
		let text = ''
		stream.on('data', (chunk: Buffer) => {
			text += chunk.toString('utf8')
		})

		// Act
		await vi.waitFor(() => {
			expect(text).toContain('"question":"Which story?"')
		}, duration.of('20s').to('ms'))
		const closing = served.close({ pause: duration.of('5s').toAbortSignal(), backend: duration.of('10s').toAbortSignal() })

		// Assert
		await expect(closing).resolves.toBeUndefined()
		expect(text.startsWith(`event: run\ndata: {"id":"${started.id}"`)).toBe(true)
	})

	test('lists the connectors it loaded, and which of them sign in', async () => {
		// Arrange
		const { client } = await serve([
			{ package: '@team/cloud', name: 'cloud', tools: [], signIn: () => Promise.resolve() },
			{ package: 'tracker', name: 'tracker', tools: [] },
		])

		// Act
		const connectors = await client.connectors(signal)

		// Assert
		expect(connectors).toEqual([
			{ name: 'cloud', package: '@team/cloud', signsIn: true },
			{ name: 'tracker', package: 'tracker', signsIn: false },
		])
	})

	test.each([
		['an unknown run', (client: ControlClient) => client.get('run-000000000000', signal), 404],
		['an app that is not deployed', (client: ControlClient) => client.startRun({ ...userRun('develop'), abortSignal: signal }), 404],
		['the settings of an app that is not deployed', (client: ControlClient) => client.missingSettings(signal), 404],
		['deploying a tarball that is not there', (client: ControlClient) => client.deploy('/nowhere/app.tgz', signal), 400],
		['resuming a run that is not paused', (client: ControlClient) => client.resume('run-000000000000', signal), 404],
		['an answer without a value', (client: ControlClient) => client.answer('run-000000000000', 'story', undefined, signal), 400],
	])('refuses %s with the right status', async (_name, call, status) => {
		// Arrange
		const { client } = await serve()

		// Act
		const calling = call(client)

		// Assert
		await expect(calling).rejects.toMatchObject({ status })
	})
})

describe.skipIf(process.platform !== 'linux')('the mesh-flow command with an engine', () => {
	test('deploys a built app, shows it and starts a run through one of its triggers', async () => {
		// Arrange
		const { client, home } = await serve()
		const folder = await builtApp({ ask })
		const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined)
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		onTestFinished(() => {
			printed.mockRestore()
			errors.mockRestore()
			process.exitCode = undefined
		})
		const command = (...commandArguments: string[]) => main(['node', 'mesh-flow', '--home', home, ...commandArguments])

		// Act
		await command('deploy', folder)
		await command('app')
		await command('trigger', 'user', 'ask', '-p', '{"story":"ABC-1"}')
		await command('trigger', 'user', 'unlisted', '-p', '{}')

		// Assert
		expect(process.exitCode).toBe(1)
		expect(errors).toHaveBeenCalledWith(expect.stringContaining('has no user trigger unlisted'))
		const deployed = await client.app(signal)
		expect(printed).toHaveBeenCalledWith(expect.stringContaining(`${deployed?.version ?? 'no version'}  built `))
		expect(await client.list(signal)).toEqual([expect.objectContaining({ workflow: 'ask', trigger: { kind: 'user', id: 'ask' } })])
	})
})

describe('the mesh-flow command', () => {
	test('says when no engine is running', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		onTestFinished(() => {
			errors.mockRestore()
			process.exitCode = undefined
		})

		// Act
		await main(['node', 'mesh-flow', '--home', home, 'list'])

		// Assert
		expect(errors).toHaveBeenCalledWith(expect.stringContaining('No engine is running'))
		expect(process.exitCode).toBe(1)
	})
})
