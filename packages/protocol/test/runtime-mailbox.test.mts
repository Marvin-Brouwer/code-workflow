import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { answerFile, mailboxLayout } from '../src/mailbox-layout.mts'
import { RuntimeMailbox } from '../src/runtime-mailbox.mts'
import { RuntimeMessage } from '../src/runtime-message.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

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
		const lines = (await readFile(mailboxLayout(directory).outbox, 'utf8')).split('\n')
		expect(lines).toHaveLength(3)
		expect(lines.slice(0, 2).map((line) => RuntimeMessage.parse(JSON.parse(line)).type)).toEqual(['event', 'succeeded'])
	})

	test('refuses a request id it sent already, which would get the old answer', async () => {
		// Arrange
		const mailbox = new RuntimeMailbox(await temporaryDirectory())
		mailbox.send({ type: 'request', request: { kind: 'wake', id: 'poll-ci', at: '2026-11-08T08:00:00.000Z' } })

		// Act
		const sendingAgain = () => {
			mailbox.send({ type: 'request', request: { kind: 'wake', id: 'poll-ci', at: '2026-11-08T08:05:00.000Z' } })
		}

		// Assert
		expect(sendingAgain).toThrow('poll-ci was sent already')
	})

	test('picks up an answer once the engine has written it', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(mailboxLayout(directory).inbox)
		const waiting = new RuntimeMailbox(directory).answer('story', signal)

		// Act
		await writeFile(answerFile(mailboxLayout(directory), 'story'), JSON.stringify({ value: { key: 'ABC-1' } }))

		// Assert
		expect(await waiting).toEqual({ value: { key: 'ABC-1' } })
	})

	test('stops waiting for an answer when its signal aborts', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(mailboxLayout(directory).inbox)
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
