/** `record[key]` when `record` has it as its own key, so a key such as `constructor` finds nothing. */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined
}
