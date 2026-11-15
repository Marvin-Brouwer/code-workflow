/**
 * Fails a run before it touches the story when the sandbox has no .NET SDK, as on the stand-in image
 * `main.mts` names until the image the Dockerfile builds is pushed: the tools and checks the
 * developers hand in with need one, and would only fail hours later.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Throws, naming what to do, when `dotnet --list-sdks` lists no SDK or `dotnet` can't run. */
export async function requireDotnetSdk(abortSignal: AbortSignal): Promise<void> {
	const sdks = await run('dotnet', ['--list-sdks'], { signal: abortSignal }).then(
		({ stdout }) => stdout.trim(),
		(error: unknown) => {
			if (abortSignal.aborted) throw error
			return ''
		},
	)
	if (sdks === '') throw new Error('The sandbox has no .NET SDK: build the image the Dockerfile describes and name it in main.mts.')
}
