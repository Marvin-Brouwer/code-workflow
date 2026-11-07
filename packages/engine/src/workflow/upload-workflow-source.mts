import { readFile } from 'node:fs/promises'
import type { Sandbox } from '@mesh-flow/sandbox'

/**
 * Unpacks a source tarball into `directory` in the sandbox. `writeFile` takes text, so the
 * tarball goes in as base64 and `base64` and `tar` in the image unpack it.
 */
export async function uploadWorkflowSource(sandbox: Sandbox, tarball: string, directory: string, signal: AbortSignal): Promise<void> {
	const staged = `${directory}.tgz.b64`
	await sandbox.writeFile(staged, (await readFile(tarball)).toString('base64'), signal)
	const unpack = 'mkdir -p "$2" && base64 -d "$1" | tar -xzf - -C "$2" && rm -f "$1"'
	const result = await sandbox.exec(['sh', '-c', unpack, 'sh', staged, directory], { signal })
	if (result.exitCode !== 0) throw new Error(`Unpacking the workflow in the sandbox failed: ${result.stderr.trim()}`)
}
