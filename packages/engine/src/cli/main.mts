import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { text } from 'node:stream/consumers'
import { buildApp } from '@mesh-flow/build'
import { AppPlatform, TriggerKind } from '@mesh-flow/protocol'
import { BackendName } from '@mesh-flow/sandbox'
import { Command, InvalidArgumentError, Option } from 'commander'
import envPaths from 'env-paths'
import { AppName, WebhookName } from '../apps/names.mts'
import { openConnectorSettings } from '../connectors/connector-settings.mts'
import { loadConnectors } from '../connectors/load-connectors.mts'
import { controlClient, type ControlClient, type DeployedApp } from '../control/control-client.mts'
import { controlSocketPath } from '../control/control-socket.mts'
import { messageOf } from '../errors.mts'
import { openEngineGatewayHome } from '../serve/engine-gateway.mts'
import { defaultWebhookHost, serveEngine, type ServedEngine, type ServeEngineOptions } from '../serve/serve-engine.mts'
import { handleShutdown } from '../shutdown/handle-shutdown.mts'
import { openWebhookSecrets } from '../triggers/webhook-secrets.mts'
import { appNameOf } from './app-name.mts'
import { addConnectorCommands, connectorSettingsFile } from './connector-commands.mts'
import { addCredentialCommands } from './credential-commands.mts'
import { formatDescription } from './format-description.mts'
import { formatRun, formatRunLine } from './format-run.mts'
import { openBackend } from './open-backend.mts'
import { addProviderCommands } from './provider-commands.mts'
import { withPackedApp } from './with-packed-app.mts'
import { watchApp } from './watch-app.mts'

/** How long a CLI command waits for the engine. */
const requestTimeoutMs = 5 * 60_000

/** How long a build may take, installing native dependencies included. */
const buildTimeoutMs = 10 * 60_000

/** Where `build` puts the built app, and where `deploy` takes it from, relative to the app. */
const defaultOut = path.join('.mesh-flow', 'app')

/** The sandbox's CPU when `--cpu` doesn't say. */
const defaultCpu: AppPlatform['cpu'] = 'x64'

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

/** The sandbox's platform: always Linux, on `cpu`. */
function sandboxPlatform(cpu: AppPlatform['cpu']): AppPlatform {
	return { os: 'linux', cpu }
}

/** `-C, --directory`: the app's repository, which every app command works from. */
function directoryOption(): Option {
	return new Option('-C, --directory <directory>', "the app's repository").default(process.cwd())
}

/** `--app`: another name than the one in the app's package.json. */
function appOption(): Option {
	return new Option('--app <name>', "the app's name (default: the name in package.json)")
}

/** The `mesh-flow` command line. */
export async function main(argv: readonly string[]): Promise<void> {
	const program = new Command('mesh-flow')
		.description('Runs mesh-flow workflows, each in its own sandbox.')
		.option('--home <directory>', "the engine's directory: run records, socket, sandbox state", envPaths('mesh-flow', { suffix: '' }).data)
		.option('--no-keychain', 'keeps the key the credentials are sealed with in a file in the home, not in the OS keychain')
		.showHelpAfterError()

	const home = () => path.resolve(program.opts<{ home: string }>().home)
	const keychain = () => program.opts<{ keychain: boolean }>().keychain
	const gatewayHome = (abortSignal: AbortSignal) => openEngineGatewayHome(home(), abortSignal, { keychain: keychain() })
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
			served = await serveWithConnectors(home(), { backend, log, keychain: keychain(), abortSignal: startup.signal, ...webhooks }).catch(
				async (error: unknown) => {
					await backend.close(AbortSignal.timeout(closeTimeoutMs))
					throw error
				},
			)
			log(`Engine ready on ${served.socketPath}.`)
			if (served.webhookUrl) log(`Webhooks go to ${served.webhookUrl}/webhooks/<app>/<webhook>.`)
		})

	program
		.command('build')
		.description(
			'Builds the app whose package.json is here into one file, with its native dependencies for the sandbox, and describes it. CI runs this.',
		)
		.addOption(directoryOption())
		.option('-o, --out <folder>', 'where the built app goes', defaultOut)
		.option('--cpu <cpu>', "the sandbox's CPU: x64 or arm64", parseCpu, defaultCpu)
		.action(async (options: { directory: string; out: string; cpu: AppPlatform['cpu'] }) => {
			const directory = path.resolve(options.directory)
			const out = path.resolve(directory, options.out)
			const manifest = await buildApp({
				directory,
				out,
				platform: sandboxPlatform(options.cpu),
				abortSignal: AbortSignal.timeout(buildTimeoutMs),
			})
			log(`Built ${path.relative(process.cwd(), out) || '.'}: ${String(manifest.description.triggers.length)} triggers.`)
		})

	program
		.command('deploy')
		.description('Hands a built app to the engine on this machine as the new current version. Its webhooks and schedules follow it.')
		.argument('[folder]', 'the built app', defaultOut)
		.addOption(directoryOption())
		.addOption(appOption())
		.action(async (folder: string, options: { directory: string; app?: string }) => {
			const directory = path.resolve(options.directory)
			const name = await appNameOf(directory, options.app)
			const deployed = await withPackedApp(
				path.resolve(directory, folder),
				(tarball) => client().deploy(name, tarball, requestSignal()),
				requestSignal(),
			)
			console.log(`${deployed.name}  ${deployed.version}`)
			reportMissing(deployed.missing)
		})

	program
		.command('dev')
		.description(
			'Builds and deploys the app here to the engine on this machine, again on every change, so its triggers are live while you work.',
		)
		.addOption(directoryOption())
		.addOption(appOption())
		.option('--cpu <cpu>', "the sandbox's CPU: x64 or arm64", parseCpu, defaultCpu)
		.action(async (options: { directory: string; app?: string; cpu: AppPlatform['cpu'] }) => {
			const directory = path.resolve(options.directory)
			const name = await appNameOf(directory, options.app)
			const out = path.join(directory, defaultOut)
			const stopping = new AbortController()
			process.once('SIGINT', () => {
				stopping.abort(new Error('Stopped.'))
			})
			const buildAndDeploy = async () => {
				try {
					const abortSignal = AbortSignal.any([stopping.signal, AbortSignal.timeout(buildTimeoutMs)])
					await buildApp({ directory, out, platform: sandboxPlatform(options.cpu), abortSignal })
					const deployed = await withPackedApp(out, (tarball) => client().deploy(name, tarball, abortSignal), abortSignal)
					log(`Deployed ${deployed.name} ${deployed.version}.`)
					reportMissing(deployed.missing)
				} catch (error) {
					if (!stopping.signal.aborted) log(`Not deployed: ${messageOf(error)}`)
				}
			}
			await buildAndDeploy()
			log('Watching for changes. Ctrl+C stops.')
			await watchApp({
				directory,
				changed: buildAndDeploy,
				log,
				stopped: () => {
					process.exitCode = 1
					stopping.abort(new Error('Stopped watching.'))
				},
				abortSignal: stopping.signal,
			})
		})

	program
		.command('trigger')
		.description(
			"Starts a run through one of the app's triggers, as the button, a delivery or the schedule would. The signature check is skipped.",
		)
		.argument('<kind>', 'user, webhook or schedule', parseTriggerKind)
		.argument('<trigger>', "its id: the workflow for a user trigger, the webhook's name, or a schedule as `mesh-flow triggers` lists it")
		.requiredOption('-p, --parameters <json>', "the workflow's parameters, or a webhook's payload: JSON, or @file")
		.addOption(directoryOption())
		.addOption(appOption())
		.action(async (kind: TriggerKind, id: string, options: { parameters: string; directory: string; app?: string }) => {
			const input = await readJsonOrFile(options.parameters)
			const app = await appNameOf(path.resolve(options.directory), options.app)
			const record = await client().startRun({ app, trigger: { kind, id }, input, abortSignal: requestSignal() })
			console.log(formatRunLine(record))
		})

	program
		.command('triggers')
		.description("Lists the workflows and triggers of the app's current version.")
		.addOption(directoryOption())
		.addOption(appOption())
		.action(async (options: { directory: string; app?: string }) => {
			const name = await appNameOf(path.resolve(options.directory), options.app)
			const deployed = await deployedApp(client(), name)
			console.log(formatDescription(deployed.manifest.description, deployed.name))
		})

	const appCommand = program.command('app').description('The apps deployed to the engine.')
	appCommand
		.command('list')
		.description('Lists the deployed apps and their current versions.')
		.action(async () => {
			for (const { name, version, manifest } of await client().apps(requestSignal()))
				console.log(`${name}  ${version}  built ${manifest.builtAt}`)
		})
	appCommand
		.command('remove')
		.description('Removes an app. Its runs stay; its webhooks and schedules stop.')
		.argument('<name>')
		.action(async (name: string) => {
			await client().removeApp(AppName.parse(name), requestSignal())
		})

	program
		.command('webhook')
		.description('Webhook settings.')
		.command('secret')
		.description("Sets the secret an app's webhook is signed with, read from stdin. It's kept in the gateway's credential store only.")
		.argument('<app>')
		.argument('<webhook>')
		.option('--generate', 'makes a random secret and prints it, to paste into the sender')
		.action(async (appName: string, webhook: string, options: { generate?: boolean }) => {
			const secret = options.generate ? randomBytes(generatedSecretBytes).toString('hex') : (await text(process.stdin)).trim()
			if (secret.length === 0) throw new Error('No secret on stdin. Pipe one in, or use --generate.')
			const abortSignal = requestSignal()
			const secrets = openWebhookSecrets((await gatewayHome(abortSignal)).credentials)
			await secrets.set(AppName.parse(appName), WebhookName.parse(webhook), secret, abortSignal)
			if (options.generate) console.log(secret)
		})

	addProviderCommands(program, gatewayHome)
	addCredentialCommands(program, gatewayHome)
	addConnectorCommands(program, home)

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

/** Says what the engine still needs before the deployed app can run, so it's known before the first trigger. */
function reportMissing(missing: readonly string[]): void {
	if (missing.length === 0) return
	log(`The app can't run until these settings are in:\n${missing.map((line) => `- ${line}`).join('\n')}`)
}

/** Where connectors keep what they hold between calls, in an engine's home. */
function connectorsDirectory(home: string): string {
	return path.join(home, 'connectors')
}

/**
 * Serves an engine with the host tools of the connector packages the user added, resolved from the
 * directory `mesh-flow serve` runs in.
 */
async function serveWithConnectors(home: string, options: Omit<ServeEngineOptions, 'home' | 'tools'>): Promise<ServedEngine> {
	const connectors = await loadConnectors({
		connectors: await openConnectorSettings(connectorSettingsFile(home)).list(options.abortSignal),
		from: process.cwd(),
		directory: connectorsDirectory(home),
	})
	for (const connector of connectors)
		log(`Loaded connector ${connector.name} from ${connector.package}: ${String(connector.tools.length)} host tools.`)
	return serveEngine({ home, tools: connectors.flatMap((connector) => connector.tools), ...options })
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

function parseCpu(value: string): AppPlatform['cpu'] {
	const parsed = AppPlatform.shape.cpu.safeParse(value)
	if (!parsed.success) throw new InvalidArgumentError('Use x64 or arm64.')
	return parsed.data
}

function parseTriggerKind(value: string): TriggerKind {
	const parsed = TriggerKind.safeParse(value)
	if (!parsed.success) throw new InvalidArgumentError(`Use one of ${TriggerKind.options.join(', ')}.`)
	return parsed.data
}

/** JSON, or the JSON in a file after `@`. */
async function readJsonOrFile(value: string): Promise<unknown> {
	return parseJson(value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value)
}

/** The current version of the deployed app called `name`. */
async function deployedApp(client: ControlClient, name: string): Promise<DeployedApp> {
	const found = (await client.apps(requestSignal())).find((app) => app.name === name)
	if (found === undefined) throw new Error(`There is no app ${name}. Deploy it with \`mesh-flow deploy\`, or run \`mesh-flow dev\`.`)
	return found
}
