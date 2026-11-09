/** Whether `error` is a Node error with this `code`, such as `ENOENT`. */
export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code
}

/** An error's message, or the value as text. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
