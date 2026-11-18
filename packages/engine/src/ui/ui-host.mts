import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from 'import-meta-resolve'
import { messageOf } from '../errors.mts'

/** The entry point `mesh-flow ui` loads the UI from: installed where `mesh-flow` runs, like a connector. */
export const uiEntry = '@mesh-flow/ui/server'

/** What `mesh-flow ui` hands the UI's server. */
export interface ServeUiOptions {
	/** The engine's home: its control socket, gateway and connector settings. */
	readonly home: string
	/** Whether the credential store's key may be in the OS keychain, as `--no-keychain` says. */
	readonly keychain: boolean
	/** The port on 127.0.0.1. `0` takes a free one. */
	readonly port: number
	/** Whether to open the page in the browser once it's served. */
	readonly open: boolean
	/** Aborting it closes the server, with requests still open. */
	readonly abortSignal: AbortSignal
}

/** A UI being served. */
export interface ServedUi {
	/** The address to open, with the token that lets this browser in. */
	readonly url: string
	/** Settles once the server closed, after `abortSignal` aborted. */
	readonly closed: Promise<void>
}

/** What `@mesh-flow/ui/server` exports as `serveUi`. */
export type ServeUi = (options: ServeUiOptions) => Promise<ServedUi>

/**
 * The UI's `serveUi`, from `@mesh-flow/ui` as installed in `from`. The engine doesn't depend on
 * the UI: it's a package of its own, which in turn uses the engine's control API.
 */
export async function importServeUi(from: string): Promise<ServeUi> {
	let url: string
	try {
		url = resolve(uiEntry, pathToFileURL(path.join(from, 'package.json')).href)
	} catch (error) {
		throw new Error(`The UI isn't installed in ${from}: add it with \`pnpm add @mesh-flow/ui\`. (${messageOf(error)})`, { cause: error })
	}
	const loaded: unknown = await import(url)
	const serveUi: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'serveUi') : undefined
	if (typeof serveUi !== 'function') throw new Error(`${uiEntry} has no serveUi: install a version of @mesh-flow/ui that fits this engine.`)
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked to be a function; its contract is this type
	return serveUi as ServeUi
}
