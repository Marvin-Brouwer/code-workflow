import path from 'node:path'

/** A path of this platform with `/` as the separator, the same on every machine. */
export function toPosix(file: string): string {
	return file.split(path.sep).join('/')
}
