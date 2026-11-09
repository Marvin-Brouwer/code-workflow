/** One line for an error, for events and the run's outcome. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
	return String(error)
}
