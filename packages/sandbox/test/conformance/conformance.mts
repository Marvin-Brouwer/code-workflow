import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { duration } from '@mesh-flow/duration'
import { afterAll, describe, expect, onTestFinished, test } from 'vitest'
import ts from 'typescript'
import { z } from 'zod'
import type { BackendName } from '../../src/backend-name.mts'
import type { SandboxBackend } from '../../src/sandbox-backend.mts'
import type { Sandbox } from '../../src/sandbox.mts'
import type { SandboxSpecification } from '../../src/sandbox-specification.mts'

const stub = guestScript('stub.mts')
const probe = guestScript('probe.mts')
const stateDirectory = '/var/tmp/conformance'
const stubLog = '/var/tmp/stub.log'
/** A script from `guest/`, transpiled to JavaScript for the image's own Node. */
function guestScript(name: string): string {
	const source = readFileSync(new URL(`guest/${name}`, import.meta.url), 'utf8')
	const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
	return ts.transpileModule(source, { compilerOptions }).outputText
}

const Waiting = z.object({ pid: z.number(), token: z.string(), checksum: z.string() })
const Done = Waiting.extend({ answer: z.object({ approved: z.boolean() }), stack: z.string() })

/** Which backends to run against: `MESH_FLOW_SANDBOX_TESTS=gvisor,microsandbox,e2b`. */
export function conformanceEnabled(backend: BackendName): boolean {
	return (process.env.MESH_FLOW_SANDBOX_TESTS ?? '').split(',').includes(backend)
}

function timeout(time = duration.of('1m')): AbortSignal {
	return time.toAbortSignal()
}

/** Reads a JSON file in the sandbox, again and again until it is there and valid, for a minute. */
async function pollJson<Value>(schema: z.ZodType<Value>, sandbox: Sandbox, file: string): Promise<Value> {
	const deadline = Date.now() + 60_000
	for (;;) {
		try {
			return schema.parse(JSON.parse(await sandbox.readFile(file, timeout())))
		} catch (error) {
			if (Date.now() > deadline) throw error
			await sleep(duration.of('500ms').to('ms'))
		}
	}
}

/** What a failure needs to tell: whether the stub still runs, what it wrote, and the state files. */
async function stubState(sandbox: Sandbox, pid: number): Promise<string> {
	const script = `head -n 3 /proc/${String(pid)}/status 2>&1; echo '--- log'; cat ${stubLog} 2>&1; echo '--- files'; ls -la ${stateDirectory} 2>&1`
	const result = await sandbox.exec(['sh', '-c', script], { signal: timeout() }).catch((error: unknown) => ({ stdout: String(error) }))
	return result.stdout
}

/**
 * The checks every backend has to pass, from the pause POCs: a pending await survives a pause
 * in the same process, memory and stack; there is no network but loopback; list, remove and close
 * leave nothing behind. Needs a real backend, so it only runs when enabled.
 *
 * @param image - An image with Node 26, such as `node:26-slim`.
 */
export function describeConformance(name: BackendName, open: () => SandboxBackend, image: string): void {
	const specification: SandboxSpecification = { image, cpus: 1, memoryMb: 1024 }

	describe.skipIf(!conformanceEnabled(name))(`${name} conformance`, () => {
		const backend = open()
		afterAll(() => backend.close(timeout()))

		/** Removes the sandbox when the test ends, also when an assertion fails. */
		function cleanUp(id: string): void {
			onTestFinished(() => backend.remove(id, timeout()))
		}

		test('a pending await resolves after pause and resume, in the same process, memory and stack', async () => {
			// Arrange
			const sandbox = await backend.create(specification, timeout())
			cleanUp(sandbox.id)
			await sandbox.writeFile('/var/tmp/stub.mjs', stub, timeout())
			await sandbox.startInBackground(['node', '/var/tmp/stub.mjs'], {
				signal: timeout(),
				environment: { STATE_DIR: stateDirectory },
				logFile: stubLog,
			})
			const waiting = await pollJson(Waiting, sandbox, `${stateDirectory}/waiting.json`)

			// Act
			const paused = await sandbox.pause(timeout(duration.of('2m')))
			const resumed = await backend.resume(paused, timeout(duration.of('2m')))
			await resumed.writeFile(`${stateDirectory}/answer.json`, JSON.stringify({ approved: true }), timeout())
			const done = await pollJson(Done, resumed, `${stateDirectory}/done.json`).catch(async (error: unknown) => {
				throw new Error(`The stub didn't finish. ${await stubState(resumed, waiting.pid)}`, { cause: error })
			})

			// Assert
			expect(done).toMatchObject({ pid: waiting.pid, token: waiting.token, checksum: waiting.checksum, answer: { approved: true } })
			expect(done.stack).toContain('at input')
			expect(done.stack).toContain('at async loop')
			expect(done.stack).toContain('at async workflow')
		})

		test('the specification environment reaches every command', async () => {
			// Arrange
			const sandbox = await backend.create({ ...specification, environment: { MESH_FLOW_CHECK: 'present' } }, timeout())
			cleanUp(sandbox.id)

			// Act
			const result = await sandbox.exec(['sh', '-c', 'echo "$MESH_FLOW_CHECK $EXTRA"'], {
				signal: timeout(),
				environment: { EXTRA: 'too' },
			})

			// Assert
			expect(result.stdout.trim()).toBe('present too')
		})

		test('writes bytes as they are, every byte value, such as a package the engine staged', async () => {
			// Arrange
			const sandbox = await backend.create(specification, timeout())
			cleanUp(sandbox.id)
			const bytes = Uint8Array.from({ length: 256 }, (_value, index) => index)

			// Act
			await sandbox.writeFile('/var/tmp/bytes.bin', bytes, timeout())
			const result = await sandbox.exec(
				['node', '-e', "process.stdout.write(require('fs').readFileSync('/var/tmp/bytes.bin').toString('hex'))"],
				{
					signal: timeout(),
				},
			)

			// Assert
			expect(result.stdout).toBe(Buffer.from(bytes).toString('hex'))
		})

		test('reaches no host, but loopback works', async () => {
			// Arrange
			const sandbox = await backend.create(specification, timeout())
			cleanUp(sandbox.id)
			await sandbox.writeFile('/var/tmp/probe.mjs', probe, timeout())

			// Act
			const result = await sandbox.exec(['node', '/var/tmp/probe.mjs', 'registry.npmjs.org', 'example.com'], { signal: timeout() })

			// Assert
			const probed = z.object({ hosts: z.record(z.string(), z.string()), loopback: z.string() }).parse(JSON.parse(result.stdout))
			expect(probed).toEqual({ hosts: { 'registry.npmjs.org': '000', 'example.com': '000' }, loopback: 'ok' })
		})

		test('list shows a paused sandbox until it is removed', async () => {
			// Arrange
			const sandbox = await backend.create(specification, timeout())
			await sandbox.pause(timeout(duration.of('2m')))

			// Act
			const before = await backend.list(timeout())
			await backend.remove(sandbox.id, timeout())
			const after = await backend.list(timeout())

			// Assert
			expect(before).toContainEqual({ id: sandbox.id, state: 'paused' })
			expect(after.map((held) => held.id)).not.toContain(sandbox.id)
		})

		test('close removes the sandboxes it still runs', async () => {
			// Arrange
			const own = open()
			const sandbox = await own.create(specification, timeout())

			// Act
			await own.close(timeout())

			// Assert
			expect((await backend.list(timeout())).map((held) => held.id)).not.toContain(sandbox.id)
		})
	})
}
