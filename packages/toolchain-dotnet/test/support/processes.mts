import { readFile } from 'node:fs/promises'

/** How often `written` looks again. */
const pollMs = 50

/** Whether a process still runs. */
export async function isRunning(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0)
	} catch {
		return false
	}
	// A killed process whose parent is gone is a zombie until the system reaps it, which a container's init may never do.
	const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => undefined)
	return stat?.split(') ')[1]?.startsWith('Z') !== true
}

/** Resolves to what is in `file` once something is, as a fake writes it once it started. */
export async function written(file: string): Promise<string> {
	for (;;) {
		const text = await readFile(file, 'utf8').catch(() => '')
		if (text !== '') return text
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
}
