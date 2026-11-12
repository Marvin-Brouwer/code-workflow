import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, onTestFinished, test } from 'vitest'
import ts from 'typescript'
import { z } from 'zod'
import type { BackendName } from '../../src/backend-name.mts'
import type { SandboxBackend } from '../../src/sandbox-backend.mts'
import type { Sandbox } from '../../src/sandbox.mts'
import type { SandboxSpec } from '../../src/sandbox-spec.mts'

const stub = guestScript('stub.mts')
const probe = guestScript('probe.mts')
const stateDir = '/var/tmp/conformance'
const stubLog = '/var/tmp/stub.log'
/** What a test spends besides its main command: create, which may pull the image, and writing files. */
const setupSeconds = 120

const npmProject = '/var/tmp/npm-check'
const npmPackage = { name: 'is-number', version: '7.0.0' }
const npmInstallSeconds = 180

const dotnetProject = '/var/tmp/dotnet-check'
const nugetPackage = { name: 'Newtonsoft.Json', version: '13.0.3' }
const dotnetInstallScriptUrl = 'https://builds.dotnet.microsoft.com/dotnet/scripts/v1/dotnet-install.sh'
const dotnetInstallScript = '/var/tmp/dotnet-install.sh'
const dotnetInstallDirectory = '/var/tmp/dotnet'
const dotnetChannel = '8.0'
const dotnetInstallSeconds = 420
const dotnetRestoreSeconds = 180
/** The SDK unpacks to about 700 MB, which gVisor keeps in memory. */
const dotnetMemoryMb = 4096
/** Keeps the SDK quiet, and off ICU, which the image may not have. */
const dotnetEnv = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }

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

function msFromSeconds(seconds: number): number {
	return seconds * 1000
}

function timeout(seconds = 60): AbortSignal {
	return AbortSignal.timeout(msFromSeconds(seconds))
}

/**
 * Installs the .NET 8 SDK with Microsoft's script and returns the path of `dotnet`. The script is
 * downloaded first: piped into bash, a failed download is an empty script that succeeds.
 */
async function installDotnetSdk(sandbox: Sandbox): Promise<string> {
	const download = `curl -fsS -o ${dotnetInstallScript} ${dotnetInstallScriptUrl}`
	const install = `bash ${dotnetInstallScript} --channel ${dotnetChannel} --install-dir ${dotnetInstallDirectory}`
	const result = await sandbox.exec(['sh', '-c', `${download} && ${install}`], { signal: timeout(dotnetInstallSeconds), env: dotnetEnv })
	if (result.exitCode !== 0) throw new Error(`Installing the .NET SDK failed: ${result.stdout}${result.stderr}`)
	return `${dotnetInstallDirectory}/dotnet`
}

/** A project that does nothing but reference one package. */
function csproj(reference: { name: string; version: string }): string {
	return [
		'<Project Sdk="Microsoft.NET.Sdk">',
		`<PropertyGroup><TargetFramework>net${dotnetChannel}</TargetFramework></PropertyGroup>`,
		`<ItemGroup><PackageReference Include="${reference.name}" Version="${reference.version}" /></ItemGroup>`,
		'</Project>',
	].join('\n')
}

/** Reads a JSON file in the sandbox, again and again until it is there and valid, for a minute. */
async function pollJson<T>(schema: z.ZodType<T>, sandbox: Sandbox, file: string): Promise<T> {
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

/** What a failure needs to tell: whether the stub still runs, what it wrote, and the state files. */
async function stubState(sandbox: Sandbox, pid: number): Promise<string> {
	const script = `head -n 3 /proc/${String(pid)}/status 2>&1; echo '--- log'; cat ${stubLog} 2>&1; echo '--- files'; ls -la ${stateDir} 2>&1`
	const result = await sandbox.exec(['sh', '-c', script], { signal: timeout() }).catch((error: unknown) => ({ stdout: String(error) }))
	return result.stdout
}

/** What the suite runs in. */
export interface ConformanceImages {
	/** Node 22, for the checks of the sandbox itself and npm. */
	readonly node: string
	/** Node 22 with curl and the CA certificates, as `node:22-bookworm` has, for the package managers that aren't Node. */
	readonly packageManagers: string
}

/**
 * The checks every backend has to pass, from the pause POCs: a pending await survives a pause
 * in the same process, memory and stack; egress reaches the allowlist only; package managers
 * install from an allowed registry; list, remove and close leave nothing behind. Needs a real
 * backend, so it only runs when enabled.
 */
export function describeConformance(name: BackendName, open: () => SandboxBackend, images: ConformanceImages): void {
	const spec: SandboxSpec = { image: images.node, cpus: 1, memoryMb: 1024, egress: { allow: [] } }

	describe.skipIf(!conformanceEnabled(name))(`${name} conformance`, () => {
		const backend = open()
		afterAll(() => backend.close(timeout()))

		/** Removes the sandbox when the test ends, also when an assertion fails. */
		function cleanUp(id: string): void {
			onTestFinished(() => backend.remove(id, timeout()))
		}

		test('a pending await resolves after pause and resume, in the same process, memory and stack', async () => {
			// Arrange
			const sandbox = await backend.create(spec, timeout())
			cleanUp(sandbox.id)
			await sandbox.writeFile('/var/tmp/stub.mjs', stub, timeout())
			await sandbox.startInBackground(['node', '/var/tmp/stub.mjs'], {
				signal: timeout(),
				env: { STATE_DIR: stateDir },
				logFile: stubLog,
			})
			const waiting = await pollJson(Waiting, sandbox, `${stateDir}/waiting.json`)

			// Act
			const paused = await sandbox.pause(timeout(120))
			const resumed = await backend.resume(paused, timeout(120))
			await resumed.writeFile(`${stateDir}/answer.json`, JSON.stringify({ approved: true }), timeout())
			const done = await pollJson(Done, resumed, `${stateDir}/done.json`).catch(async (error: unknown) => {
				throw new Error(`The stub didn't finish. ${await stubState(resumed, waiting.pid)}`, { cause: error })
			})

			// Assert
			expect(done).toMatchObject({ pid: waiting.pid, token: waiting.token, checksum: waiting.checksum, answer: { approved: true } })
			expect(done.stack).toContain('at input')
			expect(done.stack).toContain('at async loop')
			expect(done.stack).toContain('at async workflow')
		})

		test('the spec environment reaches every command', async () => {
			// Arrange
			const sandbox = await backend.create({ ...spec, env: { MESH_FLOW_CHECK: 'present' } }, timeout())
			cleanUp(sandbox.id)

			// Act
			const result = await sandbox.exec(['sh', '-c', 'echo "$MESH_FLOW_CHECK $EXTRA"'], { signal: timeout(), env: { EXTRA: 'too' } })

			// Assert
			expect(result.stdout.trim()).toBe('present too')
		})

		test('egress reaches allowed hosts only', async () => {
			// Arrange
			const sandbox = await backend.create({ ...spec, egress: { allow: ['registry.npmjs.org'] } }, timeout())
			cleanUp(sandbox.id)
			await sandbox.writeFile('/var/tmp/probe.mjs', probe, timeout())

			// Act
			const result = await sandbox.exec(['node', '--use-system-ca', '/var/tmp/probe.mjs', 'registry.npmjs.org', 'example.com'], {
				signal: timeout(),
			})

			// Assert
			const statuses = z.record(z.string(), z.string()).parse(JSON.parse(result.stdout))
			expect(statuses['registry.npmjs.org']).not.toBe('000')
			expect(statuses['example.com']).toBe('000')
		})

		test(
			'npm installs a package from an allowed registry, with no proxy or certificate settings',
			{ timeout: msFromSeconds(setupSeconds + npmInstallSeconds) },
			async () => {
				// Arrange
				const sandbox = await backend.create({ ...spec, egress: { allow: ['registry.npmjs.org'] } }, timeout())
				cleanUp(sandbox.id)
				await sandbox.exec(['mkdir', '-p', npmProject], { signal: timeout() })
				await sandbox.writeFile(`${npmProject}/package.json`, JSON.stringify({ name: 'npm-check', private: true }), timeout())

				// Act
				const result = await sandbox.exec(['npm', 'install', '--no-audit', '--no-fund', `${npmPackage.name}@${npmPackage.version}`], {
					signal: timeout(npmInstallSeconds),
					cwd: npmProject,
				})

				// Assert
				expect(result, result.stderr).toMatchObject({ exitCode: 0 })
				const manifest = await sandbox.readFile(`${npmProject}/node_modules/${npmPackage.name}/package.json`, timeout())
				expect(z.object({ version: z.string() }).parse(JSON.parse(manifest)).version).toBe(npmPackage.version)
			},
		)

		// The SDK comes from Microsoft's install script, so the test shows curl gets through too.
		test(
			'dotnet restores a package from an allowed feed, with no proxy or certificate settings',
			{ timeout: msFromSeconds(setupSeconds + dotnetInstallSeconds + dotnetRestoreSeconds) },
			async () => {
				// Arrange
				const egress = { allow: ['builds.dotnet.microsoft.com', 'api.nuget.org'] }
				const sandbox = await backend.create({ ...spec, image: images.packageManagers, memoryMb: dotnetMemoryMb, egress }, timeout())
				cleanUp(sandbox.id)
				const dotnet = await installDotnetSdk(sandbox)
				await sandbox.exec(['mkdir', '-p', dotnetProject], { signal: timeout() })
				await sandbox.writeFile(`${dotnetProject}/check.csproj`, csproj(nugetPackage), timeout())

				// Act
				const result = await sandbox.exec([dotnet, 'restore'], {
					signal: timeout(dotnetRestoreSeconds),
					cwd: dotnetProject,
					env: dotnetEnv,
				})

				// Assert
				expect(result, result.stdout + result.stderr).toMatchObject({ exitCode: 0 })
				const assets = await sandbox.readFile(`${dotnetProject}/obj/project.assets.json`, timeout())
				expect(assets).toContain(`${nugetPackage.name}/${nugetPackage.version}`)
			},
		)

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
