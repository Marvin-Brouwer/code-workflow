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

/** What the entry file's never-settling webhook schema writes to stderr once it's reached. */
const schemaReached = 'schema reached'
// A URL, because `--import` resolves like `import`: a Windows path would read as a URL scheme.
const loader = new URL('support/protocol-from-source.mts', import.meta.url).href

/** Starts an entry file the way the engine does: `node <file>`, the mailbox in the environment and the start file in it. */
async function startLikeTheEngine(source: string, start: unknown) {
	const directory = await temporaryDirectory()
	const mailbox = path.join(directory, 'mailbox')
	const layout = mailboxLayout(mailbox)
	await mkdir(layout.inbox, { recursive: true })
	await writeFile(layout.startFile, JSON.stringify(start))
	const file = path.join(directory, 'workflows', 'main.mts')
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

const entry = `
import { defineWorkflows, input, schedule, userTrigger, webhook, workflow } from '${core}'
import { z } from '${zod}'

const greet = workflow('greet', { greeting: z.string().default('Hello') }, async ({ parameters }) => {
	const { name } = await input(parameters.greeting + ', who?', { name: z.string() })
	if (name === 'nobody') throw new Error('nobody to greet')
})

const echo = workflow('echo', { issue: z.number() }, async ({ parameters }) => {
	throw new Error('issue ' + parameters.issue)
})

workflow('unlisted', async () => {})

const IssueLabeled = z.object({ label: z.string(), issue: z.object({ number: z.number() }) })
const onlyAiFix = IssueLabeled.refine((event) => event.label === 'ai-fix', 'Only ai-fix')

/** Says it was reached, then keeps the process alive without ever settling. */
function neverSettles(): Promise<boolean> {
	console.error(${JSON.stringify(schemaReached)})
	setInterval(() => undefined, 60_000)
	return new Promise(() => undefined)
}

export default defineWorkflows(
	userTrigger(greet),
	webhook(echo, onlyAiFix.transform((event) => ({ issue: event.issue.number }))),
	schedule(echo, '0 7 * * 1', { issue: 7 }),
	webhook(echo, IssueLabeled.refine(neverSettles).transform((event) => ({ issue: event.issue.number })), { name: 'stuck' }),
)
`

const greet = { mode: 'run', workflow: 'greet' }

/** The error of a `failed` message, or `undefined` for any other message. */
function errorOf(message: RuntimeMessage | undefined): string | undefined {
	return message?.type === 'failed' ? message.error : undefined
}

describe('an entry file started by the engine', () => {
	test('describes its workflows and triggers, and exits', async () => {
		// Act
		const run = await startLikeTheEngine(entry, { mode: 'describe' })

		// Assert
		expect(await run.exited, run.stderr()).toBe(0)
		expect(await run.messages()).toMatchObject([
			{
				type: 'described',
				description: {
					workflows: [{ name: 'greet' }, { name: 'echo', parameters: { required: ['issue'] } }, { name: 'unlisted' }],
					triggers: [
						{ kind: 'user', id: 'greet', workflow: 'greet' },
						{ kind: 'webhook', id: 'echo', payload: { required: ['label', 'issue'] }, signature: { scheme: 'secret-header' } },
						{ kind: 'schedule', id: 'echo 0 7 * * 1', cron: '0 7 * * 1', parameters: { issue: 7 } },
						{ kind: 'webhook', id: 'stuck' },
					],
				},
			},
		])
	})

	test('runs the workflow it was asked for with its parameters, and exits once it succeeded', async () => {
		// Arrange
		const run = await startLikeTheEngine(entry, { ...greet, input: { greeting: 'Hi' } })
		await run.untilRequested()

		// Act
		await writeFile(answerFile(run.layout, 'input-1'), JSON.stringify({ value: { name: 'Ada' } }))

		// Assert
		expect(await run.exited).toBe(0)
		const messages = await run.messages()
		expect(messages.at(-1)).toEqual({ type: 'succeeded' })
		expect(messages[0]).toMatchObject({ type: 'event', event: { type: 'workflow', workflow: 'greet', runId: 'run-1' } })
		const [request] = messages.flatMap((message) =>
			message.type === 'request' && message.request.kind === 'input' ? [message.request] : [],
		)
		expect(request?.question).toBe('Hi, who?')
	})

	test('says it failed and exits with 1 when the body throws', async () => {
		// Arrange
		const run = await startLikeTheEngine(entry, greet)
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
		const run = await startLikeTheEngine(entry, greet)
		await run.untilRequested()

		// Act
		run.child.kill('SIGTERM')

		// Assert
		expect(await run.exited, run.stderr()).toBe(1)
		expect((await run.messages()).at(-1), run.stderr()).toEqual({ type: 'failed', error: 'The run was stopped (SIGTERM).' })
	})

	test('fails a run whose parameters do not fit, before the body starts', async () => {
		// Act
		const run = await startLikeTheEngine(entry, { mode: 'run', workflow: 'echo', input: { issue: 'seven' } })

		// Assert
		expect(await run.exited, run.stderr()).toBe(1)
		expect(errorOf((await run.messages()).at(-1))).toContain("The parameters don't fit workflow echo")
	})

	test('fails a run of a workflow the entry file does not know, naming those it does', async () => {
		// Act
		const run = await startLikeTheEngine(entry, { mode: 'run', workflow: 'deploy' })

		// Assert
		expect(await run.exited, run.stderr()).toBe(1)
		expect(await run.messages()).toEqual([
			{ type: 'failed', error: "There is no workflow deploy. The entry file's modules define: greet, echo, unlisted." },
		])
	})

	test('turns a webhook delivery into parameters with its schema', async () => {
		// Act
		const run = await startLikeTheEngine(entry, {
			mode: 'run',
			workflow: 'echo',
			trigger: { kind: 'webhook', id: 'echo' },
			input: { label: 'ai-fix', issue: { number: 12 } },
		})

		// Assert
		expect(await run.exited, run.stderr()).toBe(1)
		expect((await run.messages()).at(-1)).toEqual({ type: 'failed', error: 'issue 12' })
	})

	test('skips a webhook delivery its schema turns down, without running the workflow', async () => {
		// Act
		const run = await startLikeTheEngine(entry, {
			mode: 'run',
			workflow: 'echo',
			trigger: { kind: 'webhook', id: 'echo' },
			input: { label: 'wontfix', issue: { number: 12 } },
		})

		// Assert
		expect(await run.exited, run.stderr()).toBe(0)
		const messages = await run.messages()
		expect(messages.map((message) => message.type)).toEqual(['skipped'])
		expect(messages[0]?.type === 'skipped' ? messages[0].reason : '').toContain('Only ai-fix')
	})

	test('runs a schedule with the parameters in the entry file', async () => {
		// Act
		const run = await startLikeTheEngine(entry, { mode: 'run', workflow: 'echo', trigger: { kind: 'schedule', id: 'echo 0 7 * * 1' } })

		// Assert
		expect(await run.exited, run.stderr()).toBe(1)
		expect((await run.messages()).at(-1)).toEqual({ type: 'failed', error: 'issue 7' })
	})

	// Windows has no SIGTERM: `kill` ends the process outright. The engine runs workflows in a Linux sandbox.
	test.skipIf(process.platform === 'win32')('stops on SIGTERM while a webhook schema never settles', async () => {
		// Arrange
		const run = await startLikeTheEngine(entry, {
			mode: 'run',
			workflow: 'echo',
			trigger: { kind: 'webhook', id: 'stuck' },
			input: { label: 'ai-fix', issue: { number: 12 } },
		})
		await expect.poll(() => run.stderr().includes(schemaReached), { timeout: 10_000 }).toBe(true)

		// Act
		run.child.kill('SIGTERM')

		// Assert
		expect(await run.exited, run.stderr()).toBe(1)
		expect((await run.messages()).at(-1)).toEqual({ type: 'failed', error: 'The run was stopped (SIGTERM).' })
	})
})
