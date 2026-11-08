import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { RuntimeMailbox } from '../src/runtime-mailbox.mts'
import { RuntimeMessage } from '../src/runtime-message.mts'
import { temporaryDirectory } from './temporary-directory.mts'

const signal = new AbortController().signal

describe('RuntimeMailbox', () => {
	test('appends every message as one line of the outbox', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const mailbox = new RuntimeMailbox(directory)

		// Act
		mailbox.send({ type: 'event', event: { id: '1', type: 'started', at: '2026-11-08T08:00:00.000Z', note: 'two\nlines' } })
		mailbox.send({ type: 'succeeded' })

		// Assert
		const lines = (await readFile(path.join(directory, 'outbox.jsonl'), 'utf8')).split('\n')
		expect(lines).toHaveLength(3)
		expect(lines.slice(0, 2).map((line) => RuntimeMessage.parse(JSON.parse(line)).type)).toEqual(['event', 'succeeded'])
	})

	test('picks up an answer once the engine has written it', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(path.join(directory, 'inbox'))
		const waiting = new RuntimeMailbox(directory).answer('story', signal)

		// Act
		await writeFile(path.join(directory, 'inbox', 'story.json'), JSON.stringify({ value: { key: 'ABC-1' } }))

		// Assert
		expect(await waiting).toEqual({ value: { key: 'ABC-1' } })
	})

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
		// Arrange
		const environment = {}

		// Act
		const starting = () => RuntimeMailbox.fromEnvironment(environment)

		// Assert
		expect(starting).toThrow('MESH_FLOW_MAILBOX')
	})
})
