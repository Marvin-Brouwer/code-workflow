/**
 * Loads the host half of every connector the user added (`mesh-flow connector add <package>`).
 *
 * A connector is a package that gives workflows one outside system, such as GitHub. Its sandbox
 * half is what a workflow imports: functions, agent tools and webhook triggers that need no
 * credential. Its host half, the package's `host` entry point, holds the host tools behind them:
 * the ones that do the API calls and git pushes with the credential, which only the host has.
 * The engine gives each run the host tools its app lists, and the sandbox half reaches them
 * over the gateway.
 *
 * @module
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	connectorCredentials,
	type ConnectorHost,
	type ConnectorLogin,
	type ConnectorLoginContext,
	type CredentialStore,
	type HostTool,
	type ResolveRegistryFetch,
	signInOf,
} from '@mesh-flow/gateway'
import { ConnectorName } from '@mesh-flow/protocol'
import { resolve } from 'import-meta-resolve'
import { z } from 'zod'
import { messageOf } from '../errors.mts'
import type { ConnectorSetting } from './connector-settings.mts'

/** The subpath of a connector package that exports its host half. */
export const hostEntry = 'host'

/** What a connector's host entry point has to export. */
const HostModule = z.object({
	connector: z.object({
		name: ConnectorName,
		tools: z.custom<ConnectorHost['tools']>((value) => typeof value === 'function'),
		login: z.custom<ConnectorLogin>((value) => typeof value === 'function').optional(),
		registries: z.custom<NonNullable<ConnectorHost['registries']>>((value) => typeof value === 'function').optional(),
		missingSettings: z.custom<NonNullable<ConnectorHost['missingSettings']>>((value) => typeof value === 'function').optional(),
	}),
})

/** What a loaded connector's sign-in takes: it has the connector's own credentials already. */
export type LoginContext = Omit<ConnectorLoginContext, 'credentials'>

/** A connector the engine loaded: where it came from, the host tools it brought, and how to sign in to its service. */
export interface LoadedConnector {
	readonly package: string
	readonly name: string
	readonly tools: readonly HostTool[]
	/** Signs the user in, for `mesh-flow login <name>` and runs that wait for it, when the connector's service has sessions. */
	readonly login?: (context: LoginContext) => Promise<void>
	/** How the gateway reaches the connector's package registries, when it has any. */
	readonly registries?: ResolveRegistryFetch
	/** The settings the connector still needs, each as a line that says how to set it. */
	readonly missingSettings?: (abortSignal: AbortSignal) => Promise<string[]>
}

/** What `loadConnectors` takes. */
export interface LoadConnectorsOptions {
	readonly connectors: readonly ConnectorSetting[]
	/** The directory the packages are resolved from, as `node` would from a file in it. */
	readonly from: string
	/** Where connectors keep what they hold between calls: each gets a folder of its own in it. */
	readonly directory: string
	/** The gateway's credentials. Each connector gets the ones named after it, `<connector>/...`, to write too. */
	readonly credentials: CredentialStore
}

/**
 * Loads the host halves of the connector packages the user added: each package's `host` entry
 * point, resolved from `from`, has to export `connector`, a `ConnectorHost`. Every tool name has to
 * be unique across connectors, since a run's gateway takes tools by name.
 */
export async function loadConnectors(options: LoadConnectorsOptions): Promise<LoadedConnector[]> {
	const loaded: LoadedConnector[] = []
	const owners = new Map<string, string>()
	for (const { package: name } of options.connectors) {
		const host = await importHost(name, options.from)
		const directory = path.join(options.directory, host.name)
		await mkdir(directory, { recursive: true, mode: 0o700 })
		const credentials = connectorCredentials(options.credentials, host.name)
		const hostOptions = { directory, credentials }
		const signIns = { finished: 0 }
		const tools = host.tools(hostOptions).map((tool) => ownSignIns(host.name, tool, signIns))
		for (const tool of tools) {
			const owner = owners.get(tool.name)
			if (owner !== undefined && owner !== name) throw new Error(`Connectors ${owner} and ${name} both bring a host tool ${tool.name}.`)
			owners.set(tool.name, name)
		}
		const { login, registries, missingSettings } = host
		loaded.push({
			package: name,
			name: host.name,
			tools,
			...(login === undefined
				? {}
				: {
						login: async (context: LoginContext) => {
							await login({ ...context, credentials })
							signIns.finished++
						},
					}),
			...(registries === undefined ? {} : { registries: registries(hostOptions) }),
			...(missingSettings === undefined
				? {}
				: { missingSettings: (abortSignal: AbortSignal) => missingSettings(credentials, abortSignal) }),
		})
	}
	return loaded
}

/**
 * `tool`, as the engine runs it for `connector`:
 *
 * - a sign-in it asks for has to be to its own connector's service. One to another connector's is
 *   a plain failure, so a tool can't make runs wait for a sign-in that isn't its connector's;
 * - when a sign-in to its connector finished while it ran, the tool may have read the store just
 *   before the session was written: it runs once more before it asks for another sign-in. A tool
 *   that asks for one has changed nothing yet, so running it again is safe.
 */
function ownSignIns(connector: string, tool: HostTool, signIns: { readonly finished: number }): HostTool {
	const runOnce: HostTool['run'] = async (input, context) => {
		try {
			return await tool.run(input, context)
		} catch (error) {
			const signInTo = signInOf(error)
			if (signInTo === undefined || signInTo === connector) throw error
			throw new Error(`${tool.name} asked for a sign-in to ${signInTo}, not to its own connector ${connector}: ${messageOf(error)}`, {
				cause: error,
			})
		}
	}
	return Object.freeze<HostTool>({
		name: tool.name,
		run: async (input, context) => {
			const finishedBefore = signIns.finished
			try {
				return await runOnce(input, context)
			} catch (error) {
				if (signInOf(error) === undefined || signIns.finished === finishedBefore) throw error
				return runOnce(input, context)
			}
		},
	})
}

async function importHost(name: string, from: string): Promise<ConnectorHost> {
	const specifier = `${name}/${hostEntry}`
	let url: string
	try {
		url = resolve(specifier, pathToFileURL(path.join(from, 'package.json')).href)
	} catch (error) {
		throw new Error(`Connector ${name} isn't installed in ${from}, or has no ${hostEntry} entry point: ${messageOf(error)}`, {
			cause: error,
		})
	}
	const parsed = HostModule.safeParse(await import(url))
	if (!parsed.success) throw new Error(`${specifier} doesn't export a connector host: export \`connector\` made with connectorHost.`)
	const { name: connectorName, tools, login, registries, missingSettings } = parsed.data.connector
	return {
		name: connectorName,
		tools,
		...(login === undefined ? {} : { login }),
		...(registries === undefined ? {} : { registries }),
		...(missingSettings === undefined ? {} : { missingSettings }),
	}
}
