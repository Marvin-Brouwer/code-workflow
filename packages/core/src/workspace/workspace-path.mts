import path from 'node:path'
import { currentScope } from '../run/run-scope.mts'

/**
 * Checks a workspace path: relative, and inside the workspace. Returns it in POSIX form, as agents
 * and prompts see it.
 */
export function workspacePath(value: string): string {
	const normal = path.posix.normalize(toPosix(value))
	if (path.posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')) {
		throw new Error(`${value} isn't inside the workspace: use a path relative to it.`)
	}
	return normal
}

/** A path of this platform with `/` as the separator, as agents, prompts and keys see paths. */
export function toPosix(file: string): string {
	return file.split(path.sep).join('/')
}

/** Where a workspace path is on disk, in the current run's workspace. */
export function onDisk(relative: string, what: string): string {
	return path.join(currentScope(what).run.workspace, relative)
}
