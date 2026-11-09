import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConnectorName, type ConnectorHost, type HostTool } from '@mesh-flow/gateway'
import { resolve } from 'import-meta-resolve'
import { z } from 'zod'
import { messageOf } from '../errors.mts'
import type { ConnectorSetting } from './connector-settings.mts'

/** The subpath of a connector package that exports its host half. */
export const hostEntry = 'host'

/** What a connector's host entry point has to export. */
const HostModule = z.object({
	connector: z.object({ name: ConnectorName, tools: z.custom<ConnectorHost['tools']>((value) => typeof value === 'function') }),
})

/** A connector the engine loaded: where it came from, and the host tools it brought. */
export interface LoadedConnector {
	readonly package: string
	readonly name: string
	readonly tools: readonly HostTool[]
}

/** What `loadConnectors` takes. */
export interface LoadConnectorsOptions {
	readonly connectors: readonly ConnectorSetting[]
	/** The directory the packages are resolved from, as `node` would from a file in it. */
	readonly from: string
	/** Where connectors keep what they hold between calls: each gets a folder of its own in it. */
	readonly directory: string
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
		const tools = host.tools({ directory })
		for (const tool of tools) {
			const owner = owners.get(tool.name)
			if (owner !== undefined && owner !== name) throw new Error(`Connectors ${owner} and ${name} both bring a host tool ${tool.name}.`)
			owners.set(tool.name, name)
		}
		loaded.push({ package: name, name: host.name, tools })
	}
	return loaded
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
	return parsed.data.connector
}
