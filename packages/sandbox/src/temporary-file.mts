/**
 * Where `Sandbox.writeFile` writes a file's content before it renames it into place, so a reader
 * never sees half a file. Whoever removes a written file removes this one too, in case a write
 * was cut off.
 */
export function temporaryFileOf(path: string): string {
	return `${path}.tmp`
}
