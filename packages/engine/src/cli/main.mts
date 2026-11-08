import path from 'node:path'
import { BackendName } from '@mesh-flow/sandbox'
import { Command, InvalidArgumentError } from 'commander'
import envPaths from 'env-paths'
import { controlClient } from '../control/control-client.mts'
import { controlSocketPath } from '../control/control-socket.mts'
import { messageOf } from '../errors.mts'
import { serveEngine, type ServedEngine } from '../serve/serve-engine.mts'
import { handleShutdown } from '../shutdown/handle-shutdown.mts'
import { formatRun, formatRunLine } from './format-run.mts'
import { openBackend } from './open-backend.mts'

/** How long a CLI command waits for the engine. */
const requestTimeoutMs = 5 * 60_000

/** How long closing the backend may take when the engine fails to start. */
const closeTimeoutMs = 60_000

/** What `stop`, `resume` and `restart` do. */
const actionDescriptions = {
	stop: 'Stops a run and removes its sandbox.',
	resume: 'Resumes a paused run where it was.',
	restart: 'Runs a run again from the top, with the code it first ran.',
} as const

function log(message: string): void {
	console.error(message)
}

function requestSignal(): AbortSignal {
	return AbortSignal.timeout(requestTimeoutMs)
}

/** The `mesh-flow` command line. */
export async function main(argv: readonly string[]): Promise<void> {
	const program = new Command('mesh-flow')
		.description('Runs mesh-flow workflows, each in its own sandbox.')
		.option('--home <directory>', "the engine's directory: run records, socket, sandbox state", envPaths('mesh-flow', { suffix: '' }).data)
		.showHelpAfterError()

	const home = () => path.resolve(program.opts<{ home: string }>().home)
	const client = () => controlClient(controlSocketPath(home()))

	program
		.command('serve')
		.description('Runs the engine in the foreground. Ctrl+C pauses running sandboxes and stops it.')
		.option('--backend <name>', 'the sandbox backend: microsandbox or gvisor (default: what this machine supports)', parseBackend)
		.option('--runsc <command>', "how to call runsc for gVisor, such as 'sudo /usr/bin/runsc'", (value) => value.split(' ').filter(Boolean))
		.action(async (options: { backend?: BackendName; runsc?: string[] }) => {
			const startup = new AbortController()
			const backend = await openBackend({ home: home(), log, ...options })
			let served: ServedEngine | undefined
			handleShutdown({
				log,
				shutdown: async (deadlines) => {
					startup.abort(new Error('The engine is shutting down.'))
					await (served ? served.close(deadlines) : backend.close(deadlines.backend))
				},
			})
			served = await serveEngine({ home: home(), backend, log, signal: startup.signal }).catch(async (error: unknown) => {
				await backend.close(AbortSignal.timeout(closeTimeoutMs))
				throw error
			})
			log(`Engine ready on ${served.socketPath}.`)
		})

	program
		.command('run')
		.description('Starts a run of a workflow from a workflow repository.')
		.argument('<workflow>', 'the workflow, as its file name in the workflows folder without .mts')
		.option('-C, --directory <directory>', 'the workflow repository', process.cwd())
		.action(async (workflow: string, options: { directory: string }) => {
			const record = await client().startRun({ directory: path.resolve(options.directory), workflow, signal: requestSignal() })
			console.log(formatRunLine(record))
		})

	program
		.command('list')
		.description('Lists every run.')
		.action(async () => {
			for (const record of await client().list(requestSignal())) {
				console.log(formatRunLine(record))
			}
		})

	program
		.command('show')
		.description('Shows a run, with what it waits for.')
		.argument('<run>')
		.action(async (run: string) => {
			console.log(formatRun(await client().get(run, requestSignal())))
		})

	program
		.command('events')
		.description("Prints a run's events as JSON lines.")
		.argument('<run>')
		.action(async (run: string) => {
			for (const event of await client().events(run, requestSignal())) {
				console.log(JSON.stringify(event))
			}
		})

	program
		.command('answer')
		.description('Answers an input request of a run.')
		.argument('<run>')
		.argument('<request>')
		.argument('<value>', 'the answer, as JSON', parseJson)
		.action(async (run: string, request: string, value: unknown) => {
			console.log(formatRunLine(await client().answer(run, request, value, requestSignal())))
		})

	for (const action of ['stop', 'resume', 'restart'] as const) {
		program
			.command(action)
			.description(actionDescriptions[action])
			.argument('<run>')
			.action(async (run: string) => {
				console.log(formatRunLine(await client()[action](run, requestSignal())))
			})
	}

	try {
		await program.parseAsync(argv)
	} catch (error) {
		log(messageOf(error))
		process.exitCode = 1
	}
}

function parseBackend(value: string): BackendName {
	const parsed = BackendName.safeParse(value)
	if (!parsed.success) throw new InvalidArgumentError(`Use one of ${BackendName.options.join(', ')}.`)
	return parsed.data
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		throw new InvalidArgumentError('This is not JSON. Quote strings: \'"text"\'.')
	}
}
