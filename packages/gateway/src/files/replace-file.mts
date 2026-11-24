import { setTimeout as wait } from 'node:timers/promises'
import { duration, type Duration } from '@mesh-flow/duration'
import writeFileAtomic from 'write-file-atomic'
import { hasErrorCode } from '../errors.mts'

/**
 * The errors Windows gives while something else has the file open for a moment, such as a virus
 * scanner looking at the new file or another process reading the old one: the rename that replaces
 * it is refused, and works a moment later.
 */
const briefWindowsRefusals = ['EPERM', 'EACCES', 'EBUSY']

/** How often, and how far apart, a refused replace is tried again: about 3 s in all, as the file lock waits. */
const replaceRetries = {
	attempts: 20,
	firstWait: duration.of('25ms'),
	longestWait: duration.of('250ms'),
}

/** How to replace a file. */
export interface ReplaceFileOptions {
	/** The new file's permissions, such as `0o600` for one only its owner reads. */
	readonly mode?: number
	readonly abortSignal: AbortSignal
}

/**
 * Replaces `file` with `data` at once, so a reader sees the old file or the new one, never half of
 * one. On Windows, a replace refused for a moment is tried again, for about 3 s.
 *
 * ```ts
 * await replaceFile(file, JSON.stringify(settings), {
 * 	mode: 0o600,
 * 	abortSignal,
 * })
 * ```
 */
export function replaceFile(file: string, data: string | Buffer, options: ReplaceFileOptions): Promise<void> {
	return retryingBriefRefusals(() => writeFileAtomic(file, data, optionsForWrite(options)), process.platform, options.abortSignal)
}

/** write-file-atomic's options: only a mode that is set. */
function optionsForWrite(options: ReplaceFileOptions): writeFileAtomic.Options {
	if (options.mode === undefined) return {}
	return { mode: options.mode }
}

/**
 * Runs `operation`, and on Windows runs it again while it fails with a refusal that passes, with a
 * growing wait between tries, until it works, fails otherwise, or `abortSignal` aborts.
 */
export async function retryingBriefRefusals(
	operation: () => Promise<void>,
	platform: NodeJS.Platform,
	abortSignal: AbortSignal,
): Promise<void> {
	let pause: Duration = replaceRetries.firstWait
	for (let attempt = 1; ; attempt++) {
		abortSignal.throwIfAborted()
		try {
			await operation()
			return
		} catch (error) {
			if (!passes(error, platform) || attempt >= replaceRetries.attempts) throw error
		}
		// A stop ends the wait early; the next turn throws its reason.
		await wait(pause.to('ms'), undefined, { signal: abortSignal }).catch(() => undefined)
		pause = duration({ milliseconds: Math.min(pause.to('ms') * 2, replaceRetries.longestWait.to('ms')) })
	}
}

/** Whether `error` is a refusal that passes, which only Windows gives. */
function passes(error: unknown, platform: NodeJS.Platform): boolean {
	return platform === 'win32' && briefWindowsRefusals.some((code) => hasErrorCode(error, code))
}
