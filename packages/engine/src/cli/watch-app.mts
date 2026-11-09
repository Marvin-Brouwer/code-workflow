import { watch } from 'node:fs'
import path from 'node:path'

/** Folders whose changes never change the app: dependencies, git, and the build itself. */
const ignored = new Set(['node_modules', '.git', '.mesh-flow'])

/** How long changes are gathered before one rebuild. */
const settleMs = 300

/**
 * Calls `changed` once a burst of file changes in `directory` has settled, until `abortSignal`
 * aborts. A call that is still going delays the next until it has finished.
 */
export function watchApp(directory: string, changed: () => Promise<void>, abortSignal: AbortSignal): void {
	let timer: NodeJS.Timeout | undefined
	let running = Promise.resolve()
	const watcher = watch(directory, { recursive: true, signal: abortSignal }, (_event, file) => {
		const first = file?.split(path.sep)[0]
		if (first !== undefined && ignored.has(first)) return
		clearTimeout(timer)
		timer = setTimeout(() => {
			running = running.then(changed)
		}, settleMs)
	})
	watcher.on('error', () => undefined)
	abortSignal.addEventListener('abort', () => {
		clearTimeout(timer)
	})
}
