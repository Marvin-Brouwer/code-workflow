import type { MissingSetting } from '@mesh-flow/gateway'
import { isConnectorRegistry, type PackageRegistry } from '@mesh-flow/protocol'
import type { LoadedConnector } from '../connectors/load-connectors.mts'

/** What an app uses connectors for: the host tools it calls and the registries it restores from. */
export interface ConnectorUse {
	readonly tools: readonly string[]
	readonly registries: readonly PackageRegistry[]
}

/** The settings the connectors behind `use` still need. */
export type ConnectorSettingsCheck = (use: ConnectorUse, abortSignal: AbortSignal) => Promise<MissingSetting[]>

/**
 * The settings check of the loaded connectors: for an app, each connector it uses, by a host tool
 * or a registry, says what it still needs.
 */
export function connectorSettingsOf(connectors: readonly LoadedConnector[]): ConnectorSettingsCheck {
	return async ({ tools, registries }, abortSignal) => {
		const used = connectors.filter(
			(connector) =>
				connector.tools.some((tool) => tools.includes(tool.name)) ||
				registries.some((registry) => isConnectorRegistry(registry) && registry.connector === connector.name),
		)
		const missing = await Promise.all(used.map(async (connector) => (await connector.missingSettings?.(abortSignal)) ?? []))
		return missing.flat()
	}
}
