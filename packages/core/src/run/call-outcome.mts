import type { ToolOutcome } from '../tool/tool.mts'
import type { EventFields } from './run-events.mts'

/** The most characters of a result an event keeps. */
const maxResultLength = 4000

/**
 * The fields of a call's `-succeeded` event: what it returned, cut to {@link maxResultLength}
 * characters with bytes left out, so the run view can show it, and the line that titles it.
 */
export function callOutcome({ output, title }: ToolOutcome<unknown>): EventFields {
	const result = resultText(output)
	return {
		...(result === undefined ? {} : { result }),
		...(title === undefined ? {} : { title }),
	}
}

/** `output` as text: a string as it is, anything else as JSON. `undefined` when there's nothing to show. */
function resultText(output: unknown): string | undefined {
	const text = typeof output === 'string' ? output : asJson(output)
	if (text === undefined) return undefined
	if (text.length <= maxResultLength) return text
	return `${text.slice(0, maxResultLength)}… (${String(text.length - maxResultLength)} more characters)`
}

/** `value` as JSON with bytes as their length, or a note when JSON can't hold it, such as a cycle or a bigint. */
function asJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, withoutBytes)
	} catch {
		return '(a value JSON can’t show)'
	}
}

/** Puts the length of a byte array in its place. Reads the holder, since `toJSON` (of a `Buffer`) runs before a replacer. */
function withoutBytes(this: unknown, key: string, value: unknown): unknown {
	const raw: unknown = typeof this === 'object' && this !== null ? Reflect.get(this, key) : value
	if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return `(${String(raw.byteLength)} bytes)`
	return value
}
