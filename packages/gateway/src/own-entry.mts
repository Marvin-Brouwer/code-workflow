/** `record[key]` when `record` has it as its own key, so a key such as `constructor` finds nothing. */
export function ownEntry<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined
}
