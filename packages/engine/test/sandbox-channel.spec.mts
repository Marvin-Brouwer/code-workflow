import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { RuntimeMailbox } from '../src/mailbox/runtime-mailbox.mts'
import { SandboxChannel } from '../src/mailbox/sandbox-channel.mts'
import { hostBackend } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const signal = new AbortController().signal
const at = '2026-11-07T12:00:00.000Z'

/** A channel on a host sandbox, and the mailbox directory as the host sees it. */
async function channelOnHost() {
	const root = await temporaryDirectory()
	const sandbox = await hostBackend(root).create({ image: 'host', cpus: 1, memoryMb: 256, egress: { allow: [] } }, signal)
	const channel = new SandboxChannel(sandbox, '/sandbox/mailbox')
	await channel.prepare(signal)
	return { channel, mailbox: path.join(root, sandbox.id, 'files', 'mailbox') }
}

describe.skipIf(process.platform !== 'linux')('SandboxChannel', () => {
	test('delivers the messages after the cursor', async () => {
		// Arrange
		const { channel, mailbox } = await channelOnHost()
		const runtime = new RuntimeMailbox(mailbox)
		runtime.send({ type: 'event', event: { id: '1', type: 'started', at } })
		runtime.send({ type: 'succeeded' })

		// Act
		const delivery = await channel.poll(1, signal)

		// Assert
		expect(delivery).toEqual({ kind: 'messages', messages: [{ type: 'succeeded' }], cursor: 2 })
	})

	test('leaves a line that is still being written for the next poll', async () => {
		// Arrange
		const { channel, mailbox } = await channelOnHost()
		new RuntimeMailbox(mailbox).send({ type: 'succeeded' })
		await appendFile(path.join(mailbox, 'outbox.jsonl'), '{"type":"fail')

		// Act
		const delivery = await channel.poll(0, signal)

		// Assert
		expect(delivery).toEqual({ kind: 'messages', messages: [{ type: 'succeeded' }], cursor: 1 })
	})

	test('waits for news instead of answering empty at once', async () => {
		// Arrange
		const { channel, mailbox } = await channelOnHost()
		setTimeout(() => {
			new RuntimeMailbox(mailbox).send({ type: 'succeeded' })
		}, 500)

		// Act
		const delivery = await channel.poll(0, signal)

		// Assert
		expect(delivery).toMatchObject({ kind: 'messages', cursor: 1 })
	})

	test('says the runtime is gone when its process has exited with nothing more to say', async () => {
		// Arrange
		const { channel } = await channelOnHost()
		await channel.startRuntime(['true'], { signal, cwd: '/sandbox/mailbox', env: {} })

		// Act
		const delivery = await poll()
		async function poll() {
			for (;;) {
				const result = await channel.poll(0, signal)
				if (result.kind === 'gone') return result
			}
		}

		// Assert
		expect(delivery).toEqual({ kind: 'gone' })
	})

	test('refuses a line that is not a message', async () => {
		// Arrange
		const { channel, mailbox } = await channelOnHost()
		await appendFile(path.join(mailbox, 'outbox.jsonl'), '{"type":"shrug"}\n')

		// Act
		const polling = channel.poll(0, signal)

		// Assert
		await expect(polling).rejects.toThrow("Line 1 of the runtime's outbox isn't a valid message.")
	})

	test('aborts a poll that is waiting', async () => {
		// Arrange
		const { channel } = await channelOnHost()
		const controller = new AbortController()

		// Act
		const polling = channel.poll(0, controller.signal)
		controller.abort()

		// Assert
		await expect(polling).rejects.toThrow()
	})

	test('puts an answer where the runtime picks it up', async () => {
		// Arrange
		const { channel, mailbox } = await channelOnHost()
		const waiting = new RuntimeMailbox(mailbox).answer('story', signal)

		// Act
		await channel.answer('story', { value: { key: 'ABC-1' } }, signal)

		// Assert
		expect(await waiting).toEqual({ value: { key: 'ABC-1' } })
		expect(JSON.parse(await readFile(path.join(mailbox, 'inbox', 'story.json'), 'utf8'))).toEqual({ value: { key: 'ABC-1' } })
	})
})

describe('RuntimeMailbox', () => {
	test('stops waiting for an answer when its signal aborts', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(path.join(directory, 'inbox'))
		const controller = new AbortController()

		// Act
		const waiting = new RuntimeMailbox(directory).answer('story', controller.signal)
		controller.abort()

		// Assert
		await expect(waiting).rejects.toThrow()
	})

	test('refuses to start outside the engine', () => {
		// Act
		let error: unknown
		try {
			RuntimeMailbox.fromEnvironment({})
		} catch (thrown) {
			error = thrown
		}

		// Assert
		expect(String(error)).toContain('MESH_FLOW_MAILBOX')
	})
})
