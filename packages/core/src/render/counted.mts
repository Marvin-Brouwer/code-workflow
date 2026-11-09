/** A count with its noun, singular or plural: `1 file`, `3 files`. Regular plurals only. */
export function counted(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`
}
