import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { text } from 'node:stream/consumers'
import { BackendName } from '@mesh-flow/sandbox'
import { Command, InvalidArgumentError } from 'commander'
import envPaths from 'env-paths'
import { controlClient } from '../control/control-client.mts'
import { controlSocketPath } from '../control/control-socket.mts'
import { messageOf } from '../errors.mts'
import { RepositoryName } from '../repositories/repository-store.mts'
import { defaultWebhookHost, serveEngine, type ServedEngine } from '../serve/serve-engine.mts'
import { handleShutdown } from '../shutdown/handle-shutdown.mts'
import { openWebhookSecrets, webhookSecretsFile } from '../triggers/webhook-secrets.mts'
import { WebhookName } from '../workflow/workflow-name.mts'
import { formatDescription } from './format-description.mts'
import { formatRun, formatRunLine } from './format-run.mts'
import { openBackend } from './open-backend.mts'

/** How long a CLI command waits for the engine. */
const requestTimeoutMs = 5 * 60_000

/** How long closing the backend may take when the engine fails to start. */
const closeTimeoutMs = 60_000

/** The highest TCP port number. */
const maxPort = 65_535

/** How many random bytes a generated webhook secret has. */
const generatedSecretBytes = 32

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
		.option('--webhook-port <port>', 'takes webhook deliveries on this port (default: no webhooks)', parsePort)
		.option('--webhook-host <host>', 'the address the webhook port listens on', defaultWebhookHost)
		.action(async (options: { backend?: BackendName; runsc?: string[]; webhookPort?: number; webhookHost: string }) => {
			const startup = new AbortController()
			const { webhookPort, webhookHost, ...backendOptions } = options
			const backend = await openBackend({ home: home(), log, ...backendOptions })
			let served: ServedEngine | undefined
			handleShutdown({
				log,
				shutdown: async (deadlines) => {
					startup.abort(new Error('The engine is shutting down.'))
					await (served ? served.close(deadlines) : backend.close(deadlines.backend))
				},
			})
			const webhooks = webhookPort === undefined ? {} : { webhooks: { port: webhookPort, host: webhookHost } }
			served = await serveEngine({ home: home(), backend, log, abortSignal: startup.signal, ...webhooks }).catch(async (error: unknown) => {
				await backend.close(AbortSignal.timeout(closeTimeoutMs))
				throw error
			})
			log(`Engine ready on ${served.socketPath}.`)
			if (served.webhookUrl) log(`Webhooks go to ${served.webhookUrl}/webhooks/<repository>/<webhook>.`)
		})

	program
		.command('run')
		.description("Starts a run of a workflow through the repository's entry file, workflows/main.mts.")
		.argument('<workflow>', 'the workflow, by the name workflow() gives it')
		.option('-C, --directory <directory>', 'the workflow repository', process.cwd())
		.option('-p, --parameters <json>', "the workflow's parameters, as JSON", parseJson)
		.action(async (workflow: string, options: { directory: string; parameters?: unknown }) => {
			const directory = path.resolve(options.directory)
			const record = await client().startRun({ directory, workflow, parameters: options.parameters, abortSignal: requestSignal() })
			console.log(formatRunLine(record))
		})

	program
		.command('triggers')
		.description("Lists the workflows and triggers a repository's entry file declares. Runs it in a sandbox, once per change.")
		.option('-C, --directory <directory>', 'the workflow repository', process.cwd())
		.action(async (options: { directory: string }) => {
			const directory = path.resolve(options.directory)
			const description = await client().describe(directory, requestSignal())
			const registered = (await client().repositories(requestSignal())).find((repository) => repository.directory === directory)
			console.log(formatDescription(description, registered?.name))
		})

	const repositoryCommand = program.command('repository').description('The repositories whose webhooks and schedules the engine serves.')
	repositoryCommand
		.command('add')
		.description('Registers a workflow repository, so its webhooks get a URL and its schedules run.')
		.option('-C, --directory <directory>', 'the workflow repository', process.cwd())
		.option('--name <name>', "the repository's name in webhook URLs (default: the directory's name)")
		.action(async (options: { directory: string; name?: string }) => {
			const directory = path.resolve(options.directory)
			const name = RepositoryName.parse(options.name ?? path.basename(directory).toLowerCase())
			const added = await client().addRepository({ name, directory }, requestSignal())
			console.log(`${added.name}  ${added.directory}`)
		})
	repositoryCommand
		.command('list')
		.description('Lists the registered repositories.')
		.action(async () => {
			for (const { name, directory } of await client().repositories(requestSignal())) console.log(`${name}  ${directory}`)
		})
	repositoryCommand
		.command('remove')
		.description('Unregisters a repository. Its runs stay; its webhooks and schedules stop.')
		.argument('<name>')
		.action(async (name: string) => {
			await client().removeRepository(name, requestSignal())
		})

	program
		.command('webhook')
		.description('Webhook settings.')
		.command('secret')
		.description("Sets the secret a repository's webhook is signed with, read from stdin. It's kept in the engine's home only.")
		.argument('<repository>')
		.argument('<webhook>')
		.option('--generate', 'makes a random secret and prints it, to paste into the sender')
		.action(async (repositoryName: string, webhook: string, options: { generate?: boolean }) => {
			const secret = options.generate ? randomBytes(generatedSecretBytes).toString('hex') : (await text(process.stdin)).trim()
			if (secret.length === 0) throw new Error('No secret on stdin. Pipe one in, or use --generate.')
			await openWebhookSecrets(webhookSecretsFile(home())).set(RepositoryName.parse(repositoryName), WebhookName.parse(webhook), secret)
			if (options.generate) console.log(secret)
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

function parsePort(value: string): number {
	const port = Number(value)
	if (!Number.isInteger(port) || port < 0 || port > maxPort) throw new InvalidArgumentError('Use a port number.')
	return port
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		throw new InvalidArgumentError('This is not JSON. Quote strings: \'"text"\'.')
	}
}
