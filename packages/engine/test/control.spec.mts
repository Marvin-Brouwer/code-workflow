import path from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { main } from '../src/cli/main.mts'
import { controlClient, type ControlClient } from '../src/control/control-client.mts'
import { serveEngine } from '../src/serve/serve-engine.mts'
import { hostBackend, hostSandboxLayout } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { runtimeScript, workflowRepository } from './support/workflow-repository.mts'

const signal = new AbortController().signal

async function serve() {
	const home = await temporaryDirectory()
	const served = await serveEngine({ home, backend: hostBackend(path.join(home, 'sandboxes')), layout: hostSandboxLayout, signal })
	onTestFinished(() => served.close({ pause: AbortSignal.timeout(5_000), backend: AbortSignal.timeout(10_000) }))
	const client = controlClient(served.socketPath)
	return { client, home }
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
		const directory = await workflowRepository({ ask })

		// Act
		const started = await client.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await vi.waitFor(async () => {
			expect((await client.get(started.id, signal)).pending).toHaveLength(1)
		}, 20_000)
		await client.answer(started.id, 'story', 'ABC-1', signal)
		await vi.waitFor(async () => {
			expect((await client.get(started.id, signal)).status).toBe('succeeded')
		}, 20_000)

		// Assert
		expect(await client.list(signal)).toEqual([expect.objectContaining({ id: started.id, workflow: 'ask' })])
		expect(await client.events(started.id, signal)).toEqual([expect.objectContaining({ type: 'input-answered', value: 'ABC-1' })])
	})

	test.each([
		['an unknown run', (client: ControlClient) => client.get('run-000000000000', signal), 404],
		[
			'a workflow that does not exist',
			(client: ControlClient) => client.startRun({ directory: '/nowhere', workflow: 'develop', abortSignal: signal }),
			400,
		],
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

describe('the mesh-flow command', () => {
	test('says when no engine is running', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		// Act
		await main(['node', 'mesh-flow', '--home', home, 'list'])

		// Assert
		expect(errors).toHaveBeenCalledWith(expect.stringContaining('No engine is running'))
		expect(process.exitCode).toBe(1)
		process.exitCode = 0
		errors.mockRestore()
	})
})
