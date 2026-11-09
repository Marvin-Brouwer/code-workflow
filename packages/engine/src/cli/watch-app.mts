import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { hasErrorCode, messageOf } from '../errors.mts'

/** Folders whose changes never change the app: dependencies, git, and the build itself. */
const ignored = new Set(['node_modules', '.git', '.mesh-flow'])

/** How long changes are gathered before one rebuild. */
const settleMs = 300

/**
 * Calls `changed` once a burst of file changes in `directory` has settled, until `abortSignal`
 * aborts. Changes while a call is going lead to one more call after it, however many there were;
 * a call that fails doesn't stop the next. `node_modules`, `.git` and `.mesh-flow` aren't watched
 * at all, so a large dependency tree costs no watches. What fails goes to `log`; when the watch
 * itself fails, watching stops and `stopped` is called.
 */
export async function watchApp(options: {
	readonly directory: string
	readonly changed: () => Promise<void>
	readonly log: (message: string) => void
	readonly stopped: () => void
	readonly abortSignal: AbortSignal
}): Promise<void> {
	const { directory, changed, log, abortSignal } = options
	const watchers = new Map<string, FSWatcher>()
	let timer: NodeJS.Timeout | undefined
	let running = false
	let again = false

	const changedMeanwhile = () => again
	const run = async () => {
		if (running) {
			again = true
			return
		}
		running = true
		try {
			do {
				again = false
				await changed().catch((error: unknown) => {
					log(`Rebuilding failed: ${messageOf(error)}`)
				})
				// Read through a function: set by `settle` while the call above was going.
			} while (changedMeanwhile() && !abortSignal.aborted)
		} finally {
			running = false
		}
	}
	const settle = () => {
		clearTimeout(timer)
		timer = setTimeout(() => void run(), settleMs)
	}
	const stop = () => {
		clearTimeout(timer)
		for (const watcher of watchers.values()) watcher.close()
		watchers.clear()
	}
	const failed = (error: unknown) => {
		if (abortSignal.aborted) return
		log(`Watching ${directory} failed, so changes no longer rebuild: ${messageOf(error)}`)
		stop()
		options.stopped()
	}
	const watchFolder = (name: string) => {
		if (ignored.has(name) || watchers.has(name) || abortSignal.aborted) return
		try {
			const watcher = watch(path.join(directory, name), { recursive: true }, settle)
			watcher.on('error', failed)
			watchers.set(name, watcher)
		} catch (error) {
			// Gone again before it could be watched, or not a folder after all.
			if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR')) failed(error)
		}
	}

	// The top level on its own, so a new folder there gets a watch of its own too.
	const top = watch(directory, (_event, name) => {
		if (name === null || ignored.has(name)) return
		settle()
		void readdir(directory, { withFileTypes: true }).then((entries) => {
			for (const entry of entries) if (entry.isDirectory() && entry.name === name) watchFolder(name)
		}, failed)
	})
	top.on('error', failed)
	watchers.set('.', top)
	for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) watchFolder(entry.name)
	if (abortSignal.aborted) stop()
	else abortSignal.addEventListener('abort', stop, { once: true })
}
