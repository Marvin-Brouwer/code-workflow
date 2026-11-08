import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { answerFile, mailboxEnvironmentVariable, mailboxLayout, runIdEnvironmentVariable, RuntimeMessage } from '@mesh-flow/protocol'
import { describe, expect, onTestFinished, test } from 'vitest'
import { temporaryDirectory } from './support/temporary-directory.mts'

const core = pathToFileURL(path.join(import.meta.dirname, '../src/_module/core.mts')).href
const zod = import.meta.resolve('zod')
/** How long a started workflow may take to ask for its input: node starting and loading the sources. */
const requestTimeoutMs = 10_000
// A URL, because `--import` resolves like `import`: a Windows path would read as a URL scheme.
const loader = new URL('support/protocol-from-source.mts', import.meta.url).href

/** Starts a workflow file the way the engine does: `node <file>` with the mailbox in the environment. */
async function startLikeTheEngine(source: string) {
	const directory = await temporaryDirectory()
	const mailbox = path.join(directory, 'mailbox')
	const layout = mailboxLayout(mailbox)
	await mkdir(layout.inbox, { recursive: true })
	const file = path.join(directory, 'workflows', 'greet.mts')
	await mkdir(path.dirname(file), { recursive: true })
	await writeFile(file, source)
	const child = spawn(process.execPath, ['--import', loader, file], {
		cwd: directory,
		env: { ...process.env, [mailboxEnvironmentVariable]: mailbox, [runIdEnvironmentVariable]: 'run-1', HOME: directory },
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	onTestFinished(() => {
		child.kill('SIGKILL')
	})
	let stderr = ''
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString()
	})
	const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
	const messages = async () =>
		(await readFile(layout.outbox, 'utf8').catch(() => ''))
			.split('\n')
			.filter(Boolean)
			.map((line) => RuntimeMessage.parse(JSON.parse(line)))
	const untilRequested = () =>
		expect.poll(async () => (await messages()).some((message) => message.type === 'request'), { timeout: requestTimeoutMs }).toBe(true)
	return { child, exited, messages, layout, untilRequested, stderr: () => stderr }
}

const greet = `
import { input, workflow } from '${core}'
import { z } from '${zod}'

export default workflow('greet', async () => {
	const { name } = await input('Who?', { name: z.string() })
	if (name === 'nobody') throw new Error('nobody to greet')
})
`

describe('a workflow started by the engine', () => {
	test('runs by itself on the mailbox and exits once it succeeded', async () => {
		// Arrange
		const run = await startLikeTheEngine(greet)
		await run.untilRequested()

		// Act
		await writeFile(answerFile(run.layout, 'input-1'), JSON.stringify({ value: { name: 'Ada' } }))

		// Assert
		expect(await run.exited).toBe(0)
		const messages = await run.messages()
		expect(messages.at(-1)).toEqual({ type: 'succeeded' })
		expect(messages[0]).toMatchObject({ type: 'event', event: { type: 'workflow', workflow: 'greet', runId: 'run-1' } })
	})

	test('says it failed and exits with 1 when the body throws', async () => {
		// Arrange
		const run = await startLikeTheEngine(greet)
		await run.untilRequested()

		// Act
		await writeFile(answerFile(run.layout, 'input-1'), JSON.stringify({ value: { name: 'nobody' } }))

		// Assert
		expect(await run.exited).toBe(1)
		expect((await run.messages()).at(-1)).toEqual({ type: 'failed', error: 'nobody to greet' })
	})

	// Windows has no SIGTERM: `kill` ends the process outright. The engine runs workflows in a Linux sandbox.
	test.skipIf(process.platform === 'win32')('stops on SIGTERM while it waits, and says so', async () => {
		// Arrange
		const run = await startLikeTheEngine(greet)
		await run.untilRequested()

		// Act
		run.child.kill('SIGTERM')

		// Assert
		expect(await run.exited, run.stderr()).toBe(1)
		expect((await run.messages()).at(-1), run.stderr()).toEqual({ type: 'failed', error: 'The run was stopped (SIGTERM).' })
	})
})
