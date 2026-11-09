import { watch } from 'node:fs'
import path from 'node:path'
import { messageOf } from '../errors.mts'

/** Folders whose changes never change the app: dependencies, git, and the build itself. */
const ignored = new Set(['node_modules', '.git', '.mesh-flow'])

/** How long changes are gathered before one rebuild. */
const settleMs = 300

/**
 * Calls `changed` once a burst of file changes in `directory` has settled, until `abortSignal`
 * aborts. A call that is still going delays the next until it has finished; one that fails doesn't
 * stop the next. What fails, a call or the watch itself, goes to `log`.
 */
export function watchApp(directory: string, changed: () => Promise<void>, log: (message: string) => void, abortSignal: AbortSignal): void {
	let timer: NodeJS.Timeout | undefined
	let running = Promise.resolve()
	const watcher = watch(directory, { recursive: true, signal: abortSignal }, (_event, file) => {
		const first = file?.split(path.sep)[0]
		if (first !== undefined && ignored.has(first)) return
		clearTimeout(timer)
		timer = setTimeout(() => {
			running = running.then(changed).catch((error: unknown) => {
				log(`Rebuilding failed: ${messageOf(error)}`)
			})
		}, settleMs)
	})
	watcher.on('error', (error) => {
		log(`Watching ${directory} failed, so changes no longer rebuild: ${messageOf(error)}`)
	})
	abortSignal.addEventListener('abort', () => {
		clearTimeout(timer)
	})
}
