import { readFile } from 'node:fs/promises'
import type { Sandbox } from '@mesh-flow/sandbox'

/** The base64 tarball's name while it waits in the app folder to be unpacked. */
const stagedName = '.app.tgz.b64'

/**
 * Unpacks a built app's tarball into `directory` in the sandbox. `writeFile` takes text, so the
 * tarball goes in as base64 and `base64` and `tar` in the image unpack it. The folder is made
 * first: `writeFile` needs its parent to be there, and the image may not have it.
 */
export async function uploadApp(sandbox: Sandbox, tarball: string, directory: string, abortSignal: AbortSignal): Promise<void> {
	const made = await sandbox.exec(['mkdir', '-p', directory], { signal: abortSignal })
	if (made.exitCode !== 0) throw new Error(`Making ${directory} in the sandbox failed: ${made.stderr.trim()}`)
	const staged = `${directory}/${stagedName}`
	await sandbox.writeFile(staged, (await readFile(tarball)).toString('base64'), abortSignal)
	const unpack = 'base64 -d "$1" | tar -xzf - -C "$2" && rm -f "$1"'
	const result = await sandbox.exec(['sh', '-c', unpack, 'sh', staged, directory], { signal: abortSignal })
	if (result.exitCode !== 0) throw new Error(`Unpacking the app in the sandbox failed: ${result.stderr.trim()}`)
}
