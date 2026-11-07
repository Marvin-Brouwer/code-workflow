/** Whether an error from Node carries this `code`, such as `ENOENT`. */
export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code
}

/** An error's message, or the value itself as text. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
