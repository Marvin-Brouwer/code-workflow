import path from 'node:path'

/** A path of this platform with `/` as the separator, as agents, prompts and keys see paths. */
export function toPosix(file: string): string {
	return file.split(path.sep).join('/')
}
