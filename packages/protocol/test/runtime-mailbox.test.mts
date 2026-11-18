import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { duration } from '@mesh-flow/duration'
import { describe, expect, test } from 'vitest'
import { answerFile, mailboxLayout, stagedFile } from '../src/mailbox-layout.mts'
import { RuntimeMailbox } from '../src/runtime-mailbox.mts'
import { RuntimeMessage } from '../src/runtime-message.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal
/** Past the mailbox's first look for an answer and well before its next one (it looks every 250 ms). */
const pastFirstLook = duration.of('50ms')

describe('RuntimeMailbox', () => {
	test('imports nothing but Node and the mailbox layout, since it runs in the sandbox without dependencies', async () => {
		// Arrange
		const sources = path.join(import.meta.dirname, '..', 'src')

		// Act
		const imported = await Promise.all(
			['runtime-mailbox.mts', 'mailbox-layout.mts'].map(async (file) => {
				const source = await readFile(path.join(sources, file), 'utf8')
				return [...source.matchAll(/^import (?!type )[^'"]*['"]([^'"]+)['"]/gm)].map(([, specifier]) => specifier)
			}),
		)

		// Assert
		expect(imported.flat().filter((specifier) => !specifier?.startsWith('node:'))).toEqual(['./mailbox-layout.mts'])
	})

	test('says where a staged body is, and refuses a name that could point elsewhere', () => {
		// Arrange
		const mailbox = new RuntimeMailbox('/mailbox')

		// Act
		const staged = mailbox.staged('call-1.body')
		const elsewhere = () => mailbox.staged('../outbox.jsonl')

		// Assert
		expect(staged).toBe(stagedFile(mailboxLayout('/mailbox'), 'call-1.body'))
		expect(staged).toMatch(/[/\\]staged[/\\]call-1\.body$/)
		expect(elsewhere).toThrow("isn't the name of a staged file")
	})

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

	test('reads what the engine started it to do', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await writeFile(mailboxLayout(directory).startFile, JSON.stringify({ mode: 'describe' }))
		const mailbox = new RuntimeMailbox(directory)

		// Act
		const start = await mailbox.readStart(abortSignal)

		// Assert
		expect(start).toEqual({ mode: 'describe' })
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

	test('lets a request whose send failed be sent again under the same id', async () => {
		// Arrange
		const directory = path.join(await temporaryDirectory(), 'not-made-yet')
		const mailbox = new RuntimeMailbox(directory)
		const request = { type: 'request', request: { kind: 'wake', id: 'later', at: '2026-11-08T08:00:00.000Z' } } as const
		try {
			mailbox.send(request)
		} catch {
			// Fails: the mailbox's directory isn't there yet.
		}
		await mkdir(directory)

		// Act
		mailbox.send(request)

		// Assert
		const lines = (await readFile(mailboxLayout(directory).outbox, 'utf8')).split('\n').filter(Boolean)
		expect(lines).toEqual([JSON.stringify(request)])
	})

	test('picks up an answer once the engine has written it', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(mailboxLayout(directory).inbox)
		const waiting = new RuntimeMailbox(directory).answer('story', abortSignal)

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

	test('rejects with the reason the abortSignal aborted with, also between two looks', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(mailboxLayout(directory).inbox)
		const controller = new AbortController()
		const waiting = new RuntimeMailbox(directory).answer('story', controller.signal)
		await new Promise((resolve) => setTimeout(resolve, pastFirstLook.to('ms')))

		// Act
		controller.abort(new Error('The run was stopped (SIGTERM).'))

		// Assert
		await expect(waiting).rejects.toThrow('The run was stopped (SIGTERM).')
	})

	test('takes the gateway grant once, and removes the file', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const grant = { endpoint: 'run', tokens: ['a'.repeat(32)] }
		await writeFile(mailboxLayout(directory).grantFile, JSON.stringify(grant))
		const mailbox = new RuntimeMailbox(directory)

		// Act
		const taken = await mailbox.takeGrant(abortSignal)

		// Assert
		expect(taken).toEqual(grant)
		expect(await mailbox.takeGrant(abortSignal)).toBeUndefined()
	})

	test("takes a call's answer and removes it from the inbox", async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const layout = mailboxLayout(directory)
		await mkdir(layout.inbox)
		const mailbox = new RuntimeMailbox(directory)
		mailbox.send({ type: 'call', id: 'call-1', endpoint: 'run', token: 'a'.repeat(32), call: { type: 'resolve-model', model: 'm' } })
		await writeFile(answerFile(layout, 'call-1'), JSON.stringify({ value: { outcome: { ok: true, result: 1 } } }))

		// Act
		const answer = await mailbox.take('call-1', abortSignal)

		// Assert
		expect(answer).toEqual({ value: { outcome: { ok: true, result: 1 } } })
		await expect(readFile(answerFile(layout, 'call-1'), 'utf8')).rejects.toThrow('ENOENT')
	})

	test('refuses a call id it sent already', async () => {
		// Arrange
		const mailbox = new RuntimeMailbox(await temporaryDirectory())
		const call = {
			type: 'call',
			id: 'call-1',
			endpoint: 'run',
			token: 'a'.repeat(32),
			call: { type: 'resolve-model', model: 'm' },
		} as const
		mailbox.send(call)

		// Act
		const sendingAgain = () => {
			mailbox.send(call)
		}

		// Assert
		expect(sendingAgain).toThrow('call-1 was sent already')
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
