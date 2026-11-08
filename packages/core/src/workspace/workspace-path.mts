import path from 'node:path'
import { currentScope } from '../run/run-scope.mts'

/**
 * Checks a workspace path: relative, and inside the workspace. Returns it in POSIX form, as agents
 * and prompts see it.
 */
export function workspacePath(value: string): string {
	const normal = path.posix.normalize(value.split(path.sep).join('/'))
	if (path.posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')) {
		throw new Error(`${value} isn't inside the workspace: use a path relative to it.`)
	}
	return normal
}

/** Where a workspace path is on disk, in the current run's workspace. */
export function onDisk(relative: string, what: string): string {
	return path.join(currentScope(what).run.workspace, relative)
}
