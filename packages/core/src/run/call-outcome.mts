import type { ToolOutcome } from '../tool/tool.mts'
import type { EventFields } from './run-events.mts'

/** The most characters of a result an event keeps. */
const maxResultLength = 4000

/**
 * The fields of a call's `-succeeded` event, so the run view can show it: what it returned as
 * text, with byte arrays shown as their length, and the line that titles it. The text is for
 * reading, not for parsing: a longer one is cut to {@link maxResultLength} characters, says how
 * much is left out, and has `resultCut` set.
 */
export function callOutcome({ output, title }: ToolOutcome<unknown>): EventFields {
	const text = typeof output === 'string' ? output : asJson(output)
	return {
		...(text === undefined ? {} : shown(text)),
		...(title === undefined ? {} : { title }),
	}
}

/** `text` as the event's `result`, cut when it's longer than {@link maxResultLength}. */
function shown(text: string): EventFields {
	if (text.length <= maxResultLength) return { result: text }
	const leftOut = text.length - maxResultLength
	return { result: `${text.slice(0, maxResultLength)}… (${String(leftOut)} more characters)`, resultCut: true }
}

/** `value` as JSON with byte arrays as their length, or a note when JSON can't hold it, such as a cycle or a bigint. */
function asJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, withoutBytes)
	} catch {
		return "(a value JSON can't show)"
	}
}

/** Puts the length of a byte array in its place. Reads the holder, since `toJSON` (of a `Buffer`) runs before a replacer. */
function withoutBytes(this: unknown, key: string, value: unknown): unknown {
	const raw: unknown = typeof this === 'object' && this !== null ? Reflect.get(this, key) : value
	if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return `(${String(raw.byteLength)} bytes)`
	return value
}
