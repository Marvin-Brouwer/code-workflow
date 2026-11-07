/**
 * Runs inside the sandbox: a fake workflow that waits for an answer the way `input()` will.
 *
 * The test transpiles it to JavaScript first, so it runs on the image's own Node. It talks to the
 * host through files in STATE_DIR only, so no connection is open while the sandbox is paused.
 *
 *   waiting.json  written once it waits: pid, a random token, a memory checksum, the stack
 *   answer.json   written by the test after resume; resolves the pending await
 *   done.json     written when it finishes: what survived the pause
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const stateDir = process.env.STATE_DIR ?? '/var/tmp/conformance'
const memoryMb = Number(process.env.STUB_MEMORY_MB ?? '128')

// State that only survives if memory does.
const token = randomUUID()
const ballast = Buffer.alloc(memoryMb * 1024 * 1024)
for (let offset = 0; offset < ballast.length; offset += 4096) ballast.writeUInt32LE(offset % 0xffffffff, offset)
const checksum = (): string => createHash('sha256').update(ballast).digest('hex')

async function waitForFile(file: string): Promise<unknown> {
	for (;;) {
		try {
			return JSON.parse(await readFile(file, 'utf8')) as unknown
		} catch {
			await sleep(200)
		}
	}
}

async function input(): Promise<{ answer: unknown; stack: string | undefined }> {
	await writeFile(`${stateDir}/waiting.json`, JSON.stringify({ pid: process.pid, token, checksum: checksum() }))
	const answer = await waitForFile(`${stateDir}/answer.json`)
	return { answer, stack: new Error('resumed').stack }
}

async function loop(): ReturnType<typeof input> {
	return input()
}

async function workflow(): Promise<void> {
	const result = await loop()
	await writeFile(`${stateDir}/done.json`, JSON.stringify({ pid: process.pid, token, checksum: checksum(), ...result }))
}

await mkdir(stateDir, { recursive: true })
await workflow()
