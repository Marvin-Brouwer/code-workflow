import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { z } from 'zod'
import { temporaryDirectory } from './temporary-directory.mts'

/** How the fake answers one command, such as `build`. */
export interface FakeAnswer {
	readonly stdout?: string
	readonly exitCode?: number
	/** TRX files to write into `--results-directory`, as `dotnet test` does. */
	readonly trx?: readonly string[]
	/** Never exits, as a build that hangs. */
	readonly hang?: boolean
}

/** One logged call. */
const Arguments = z.array(z.string())

const script = fileURLToPath(new URL('fake-dotnet.mjs', import.meta.url))

/**
 * Puts a fake `dotnet` first on the `PATH` for the test, answering each command as `answers` says,
 * and resolves to a reader of the calls it got.
 */
export async function fakeDotnet(answers: Readonly<Record<string, FakeAnswer>>) {
	const bin = await temporaryDirectory()
	const log = path.join(bin, 'calls.log')
	const answersFile = path.join(bin, 'answers.json')
	await writeFile(log, '')
	await writeFile(answersFile, JSON.stringify(answers))
	await writeFile(path.join(bin, 'dotnet'), `#!/bin/sh\nexec node "${script}" "$@"\n`)
	await chmod(path.join(bin, 'dotnet'), 0o755)
	await writeFile(path.join(bin, 'dotnet.cmd'), `@node "${script}" %*\r\n`)
	vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
	vi.stubEnv('FAKE_DOTNET_LOG', log)
	vi.stubEnv('FAKE_DOTNET_SCRIPT', answersFile)
	return {
		/** The arguments of every call, in order. */
		async calls(): Promise<string[][]> {
			const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean)
			return lines.map((line) => Arguments.parse(JSON.parse(line)))
		},
	}
}
