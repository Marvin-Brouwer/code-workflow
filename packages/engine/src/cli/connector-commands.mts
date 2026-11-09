import path from 'node:path'
import type { Command } from 'commander'
import { connectorSettingsFileName, openConnectorSettings } from '../connectors/connector-settings.mts'
import { homeCommandAbortSignal } from './home-command-abort-signal.mts'

/** The connector settings' file in an engine's home. */
export function connectorSettingsFile(home: string): string {
	return path.join(home, connectorSettingsFileName)
}

/**
 * `mesh-flow connector ...`: the connector packages the engine loads host tools from. They run on
 * the host with credentials, so which ones load is the user's setting, never the app's. A change
 * counts the next time the engine starts.
 */
export function addConnectorCommands(program: Command, home: () => string): void {
	const connector = program
		.command('connector')
		.description('Connector packages whose host tools the engine loads when it starts, from where `mesh-flow serve` runs.')

	connector
		.command('add')
		.description('Adds a connector package, such as @mesh-flow/github. Install it where `mesh-flow serve` runs.')
		.argument('<package>')
		.action(async (name: string) => {
			await openConnectorSettings(connectorSettingsFile(home())).add(name, homeCommandAbortSignal())
			console.error('Start the engine again to load it.')
		})

	connector
		.command('list')
		.description('Lists the connector packages.')
		.action(async () => {
			for (const known of await openConnectorSettings(connectorSettingsFile(home())).list(homeCommandAbortSignal()))
				console.log(known.package)
		})

	connector
		.command('remove')
		.description('Removes a connector package.')
		.argument('<package>')
		.action(async (name: string) => {
			if (!(await openConnectorSettings(connectorSettingsFile(home())).remove(name, homeCommandAbortSignal())))
				throw new Error(`There is no connector ${name}.`)
		})
}
