import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, test } from 'vitest'
import ts from 'typescript'
import { z } from 'zod'
import type { BackendName } from '../../src/paused-sandbox.mts'
import type { SandboxBackend } from '../../src/sandbox-backend.mts'
import type { Sandbox } from '../../src/sandbox.mts'
import type { SandboxSpec } from '../../src/sandbox-spec.mts'
import { startInBackground } from '../../src/start-in-background.mts'

const stub = guestScript('stub.mts')
const probe = guestScript('probe.mts')
const stateDir = '/var/tmp/conformance'

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

function timeout(seconds = 60): AbortSignal {
	return AbortSignal.timeout(seconds * 1000)
}

async function readJson<T>(schema: z.ZodType<T>, sandbox: Sandbox, file: string): Promise<T> {
	const deadline = Date.now() + 60_000
	for (;;) {
		try {
			return schema.parse(JSON.parse(await sandbox.readFile(file, timeout())))
		} catch (error) {
			if (Date.now() > deadline) throw error
			await sleep(500)
		}
	}
}

/**
 * The checks every backend has to pass, from the pause POCs: a pending await survives a pause
 * in the same process, memory and stack; egress reaches the allowlist only; list, remove and
 * close leave nothing behind. Needs a real backend, so it only runs when enabled.
 */
export function describeConformance(name: BackendName, open: () => SandboxBackend, image: string): void {
	const spec: SandboxSpec = { image, cpus: 1, memoryMb: 1024, egress: { allow: [] } }

	describe.skipIf(!conformanceEnabled(name))(`${name} conformance`, () => {
		const backend = open()
		afterAll(() => backend.close(timeout()))

		test('a pending await resolves after pause and resume, in the same process, memory and stack', async () => {
			// Arrange
			const sandbox = await backend.create(spec, timeout())
			await sandbox.writeFile('/var/tmp/stub.mjs', stub, timeout())
			await startInBackground(sandbox, ['node', '/var/tmp/stub.mjs'], { signal: timeout(), env: { STATE_DIR: stateDir } })
			const waiting = await readJson(Waiting, sandbox, `${stateDir}/waiting.json`)

			// Act
			const paused = await sandbox.pause(timeout(120))
			const resumed = await backend.resume(paused, timeout(120))
			await resumed.writeFile(`${stateDir}/answer.json`, JSON.stringify({ approved: true }), timeout())
			const done = await readJson(Done, resumed, `${stateDir}/done.json`)

			// Assert
			expect(done).toMatchObject({ pid: waiting.pid, token: waiting.token, checksum: waiting.checksum, answer: { approved: true } })
			expect(done.stack).toContain('at input')
			expect(done.stack).toContain('at async loop')
			expect(done.stack).toContain('at async workflow')
			await resumed.destroy(timeout())
		})

		test('the spec environment reaches every command', async () => {
			// Arrange
			const sandbox = await backend.create({ ...spec, env: { MESH_FLOW_CHECK: 'present' } }, timeout())

			// Act
			const result = await sandbox.exec(['sh', '-c', 'echo "$MESH_FLOW_CHECK $EXTRA"'], { signal: timeout(), env: { EXTRA: 'too' } })

			// Assert
			expect(result.stdout.trim()).toBe('present too')
			await sandbox.destroy(timeout())
		})

		test('egress reaches allowed hosts only', async () => {
			// Arrange
			const sandbox = await backend.create({ ...spec, egress: { allow: ['registry.npmjs.org'] } }, timeout())
			await sandbox.writeFile('/var/tmp/probe.mjs', probe, timeout())

			// Act
			const result = await sandbox.exec(['node', '--use-system-ca', '/var/tmp/probe.mjs', 'registry.npmjs.org', 'example.com'], {
				signal: timeout(),
			})

			// Assert
			const statuses = z.record(z.string(), z.string()).parse(JSON.parse(result.stdout))
			expect(statuses['registry.npmjs.org']).not.toBe('000')
			expect(statuses['example.com']).toBe('000')
			await sandbox.destroy(timeout())
		})

		test('list shows a paused sandbox until it is removed', async () => {
			// Arrange
			const sandbox = await backend.create(spec, timeout())
			await sandbox.pause(timeout(120))

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
			const sandbox = await own.create(spec, timeout())

			// Act
			await own.close(timeout())

			// Assert
			expect((await backend.list(timeout())).map((held) => held.id)).not.toContain(sandbox.id)
		})
	})
}
