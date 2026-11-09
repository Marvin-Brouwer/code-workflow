import { readFile } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { hasErrorCode } from '../errors.mts'

/** An npm package name, scoped or not. */
export const PackageName = z
	.string()
	.regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, 'Use an npm package name, such as @mesh-flow/github.')
export type PackageName = z.infer<typeof PackageName>

/** A connector package the engine loads host tools from. */
export const ConnectorSetting = z.object({ package: PackageName })
export type ConnectorSetting = z.infer<typeof ConnectorSetting>

const ConnectorSettingsFile = z.object({ connectors: z.array(ConnectorSetting) })

/** The connector settings' file in an engine's home. */
export const connectorSettingsFileName = 'connectors.json'

/**
 * The connector packages the engine loads host tools from when it starts. Set with
 * `mesh-flow connector`, never by an app: what runs on the host with credentials is the user's
 * call. Read again on every use.
 */
export interface ConnectorSettings {
	readonly list: (abortSignal: AbortSignal) => Promise<ConnectorSetting[]>
	/** Adds a package, once. */
	readonly add: (name: string, abortSignal: AbortSignal) => Promise<void>
	/** Removes a package. Resolves `false` when it wasn't listed. */
	readonly remove: (name: string, abortSignal: AbortSignal) => Promise<boolean>
}

/** The connector settings kept in `file`. */
export function openConnectorSettings(file: string): ConnectorSettings {
	const list = async (abortSignal: AbortSignal): Promise<ConnectorSetting[]> => {
		const text = await readFile(file, { encoding: 'utf8', signal: abortSignal }).catch((error: unknown) => {
			if (hasErrorCode(error, 'ENOENT')) return undefined
			throw error
		})
		return text === undefined ? [] : ConnectorSettingsFile.parse(JSON.parse(text)).connectors
	}
	const write = async (connectors: ConnectorSetting[], abortSignal: AbortSignal) => {
		abortSignal.throwIfAborted()
		await writeFileAtomic(file, `${JSON.stringify({ connectors }, null, '\t')}\n`, { mode: 0o600 })
	}
	return Object.freeze<ConnectorSettings>({
		list,
		async add(name, abortSignal) {
			const checked = PackageName.parse(name)
			const connectors = await list(abortSignal)
			if (connectors.some((known) => known.package === checked)) return
			await write([...connectors, { package: checked }], abortSignal)
		},
		async remove(name, abortSignal) {
			const connectors = await list(abortSignal)
			const rest = connectors.filter((known) => known.package !== name)
			if (rest.length === connectors.length) return false
			await write(rest, abortSignal)
			return true
		},
	})
}
