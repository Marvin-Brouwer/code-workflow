import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { runCheck } from '@mesh-flow/core'
import { describe, expect, onTestFinished, test } from 'vitest'
import { build } from '../src/build/build.mts'
import { updatePackages } from '../src/packages/update-packages.mts'
import { runDotnet } from '../src/run-dotnet.mts'
import { security } from '../src/security/security.mts'
import { test as testTool } from '../src/test-run/test.mts'
import { tests } from '../src/test-run/tests-check.mts'
import { fakeDotnet } from './support/fake-dotnet.mts'
import {
	auditProblemList,
	brokenBuild,
	failingTestOutput,
	failingTrx,
	passingTrx,
	referencedList,
	unversionedVulnerableList,
	vulnerableList,
} from './support/fixtures.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { isRunning, written } from './support/processes.mts'
import { toolContext } from './support/tool-context.mts'

/** How soon a call that stopped has to settle. */
const promptlyMs = 1000

/** Time for the fake `dotnet` to have started before the call stops. */
const startedMs = 300

/** How long a run of the fake holds on, long enough that two runs at once would overlap. */
const holdMs = 500

/** Longer than `runDotnet` waits after a stop before it kills outright. */
const afterForceKillMs = 3_000

/**
 * Starts the work, stops it once the fake `dotnet` had time to start, and resolves to how long the
 * work took to settle after the stop, having checked it rejected with the stop's reason.
 */
async function settleAfterStop(start: (context: { abortSignal: AbortSignal }) => Promise<unknown>): Promise<number> {
	const controller = new AbortController()
	const working = start({ abortSignal: controller.signal })
	await new Promise((resolve) => setTimeout(resolve, startedMs))
	const started = performance.now()
	controller.abort(new Error('The run stopped.'))
	await expect(working).rejects.toThrow('The run stopped.')
	return performance.now() - started
}

describe('build', () => {
	test('builds the directory without build servers, and hands back its errors and how many warnings it had', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ build: { stdout: brokenBuild, exitCode: 1 } })

		// Act
		const result = await build({ directory }, toolContext())

		// Assert
		expect(result).toMatchObject({ succeeded: false, warnings: 2, errors: [{ code: 'CS1002', line: 12 }] })
		expect(await cli.calls()).toEqual([
			['build', directory, '--configuration', 'Debug', '-nologo', '--disable-build-servers', '-clp:NoSummary'],
		])
	})

	test('hands back the end of the output when the build fails without an error MSBuild names', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ build: { stdout: 'A compatible .NET SDK was not found.\n', exitCode: 145 } })

		// Act
		const result = await build({ directory }, toolContext())

		// Assert
		expect(result).toEqual({ succeeded: false, errors: [], warnings: 0, output: 'A compatible .NET SDK was not found.' })
	})

	test('settles promptly when the call stops while the build never ends', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ build: { hang: true } })

		// Act
		const settledMs = await settleAfterStop((context) => build({ directory }, context))

		// Assert
		expect(settledMs).toBeLessThan(promptlyMs)
	})
})

describe('test and tests', () => {
	test('the tool runs the tests with a filter and hands back the failures from every test project', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ test: { exitCode: 1, trx: [failingTrx, passingTrx] } })

		// Act
		const result = await testTool({ directory, filter: 'FullyQualifiedName~Login' }, toolContext())

		// Assert
		expect(result).toMatchObject({ succeeded: false, passed: 2, failed: 1, skipped: 1, buildErrors: [] })
		expect(result.failures.map((failure) => failure.name)).toEqual(['Api.Tests.LoginTests.SetsSameSite'])
		const [call] = await cli.calls()
		expect(call).toEqual(expect.arrayContaining(['test', directory, '--logger', 'trx', '--filter', 'FullyQualifiedName~Login']))
	})

	test('the check reports each failed test', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ test: { exitCode: 1, trx: [failingTrx] } })

		// Act
		const failures = await runCheck(tests({ directory }), toolContext())

		// Assert
		expect(failures).toEqual([
			{
				source: 'test: Api.Tests.LoginTests.SetsSameSite',
				message:
					'Assert.Equal() Failure: Expected "None", Actual "Lax"\nat Api.Tests.LoginTests.SetsSameSite() in /work/api/tests/LoginTests.cs:line 21',
			},
		])
	})

	test('reports the failed test, not a build error, for a line of its output that looks like one', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ test: { exitCode: 1, stdout: failingTestOutput, trx: [failingTrx] } })

		// Act
		const findings = await runCheck(tests({ directory }), toolContext())

		// Assert
		expect(findings.map((finding) => finding.source)).toEqual(['test: Api.Tests.LoginTests.SetsSameSite'])
	})

	test('settles promptly when the run stops while the tests never end, and leaves no results behind', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ test: { hang: true } })

		// Act
		const toolSettledMs = await settleAfterStop((context) => testTool({ directory }, context))
		const checkSettledMs = await settleAfterStop((context) => runCheck(tests({ directory }), context))

		// Assert
		expect(toolSettledMs).toBeLessThan(promptlyMs)
		expect(checkSettledMs).toBeLessThan(promptlyMs)
		const results = (await cli.calls()).map((call) => call[call.indexOf('--results-directory') + 1] ?? '')
		expect(results).toHaveLength(2)
		expect(results.filter((folder) => existsSync(folder))).toEqual([])
	})

	test('the check reports the build errors when it does not build', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ test: { exitCode: 1, stdout: brokenBuild } })

		// Act
		const buildErrors = await runCheck(tests({ directory }), toolContext())

		// Assert
		expect(buildErrors).toEqual([{ source: 'build', message: '/work/api/src/Login.cs(12,34): CS1002: ; expected' }])
	})

	test('the check tests the project the options name, relative to the checkout', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(path.join(directory, 'tests'))
		const cli = await fakeDotnet({ test: { trx: [passingTrx] } })

		// Act
		await runCheck(tests({ directory }, { target: 'tests/Api.Tests.csproj' }), toolContext())

		// Assert
		const [call] = await cli.calls()
		expect(call?.[1]).toBe(path.join(directory, 'tests', 'Api.Tests.csproj'))
	})

	test('the check passes when every test passed', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ test: { trx: [passingTrx] } })

		// Act
		const findings = await runCheck(tests({ directory }), toolContext())

		// Assert
		expect(findings).toEqual([])
	})
})

describe('security', () => {
	test('reports each vulnerable package once, transitive ones too, with its advisories', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ list: { stdout: vulnerableList } })

		// Act
		const findings = await runCheck(security({ directory }), toolContext())

		// Assert
		expect(findings).toEqual([
			{
				source: 'vulnerable packages',
				message: 'package Newtonsoft.Json 12.0.1 has known vulnerabilities: High (https://github.com/advisories/GHSA-5crp-9r3c-p9vr)',
			},
			{
				source: 'vulnerable packages',
				message:
					'transitive package System.Text.RegularExpressions 4.3.0 has known vulnerabilities: High (https://github.com/advisories/GHSA-cmhx-cq75-c4mj)',
			},
		])
		const calls = await cli.calls()
		expect(calls.map((call) => call[0])).toEqual(['restore', 'list'])
		expect(calls[1]).toEqual(['list', directory, 'package', '--vulnerable', '--include-transitive', '--format', 'json'])
	})

	test('names a vulnerable package without a version by its id alone', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ list: { stdout: unversionedVulnerableList } })

		// Act
		const findings = await runCheck(security({ directory }), toolContext())

		// Assert
		expect(findings.map((finding) => finding.message)).toEqual(['package Newtonsoft.Json has known vulnerabilities: High'])
	})

	test('fails with what was written when the list writes no JSON', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ list: { stdout: 'Workload updates are available.\n' } })

		// Act
		const checking = runCheck(security({ directory }), toolContext())

		// Assert
		await expect(checking).rejects.toThrow('dotnet list package wrote no JSON:\nWorkload updates are available.')
	})

	test('lists the solution the options name, relative to the checkout', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(path.join(directory, 'src'))
		const cli = await fakeDotnet({ list: { stdout: vulnerableList } })

		// Act
		await runCheck(security({ directory }, { target: 'src/App.slnx' }), toolContext())

		// Assert
		const solution = path.join(directory, 'src', 'App.slnx')
		expect((await cli.calls()).map((call) => call[1])).toEqual([solution, solution])
	})

	test('fails, saying why, when the list could not tell whether a package is vulnerable', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ list: { stdout: auditProblemList } })

		// Act
		const checking = runCheck(security({ directory }), toolContext())

		// Assert
		await expect(checking).rejects.toThrow('The source https://feed.example/v3/index.json has no vulnerability data.')
	})

	test('settles promptly when the run stops while the restore never ends', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ restore: { hang: true } })

		// Act
		const settledMs = await settleAfterStop((context) => runCheck(security({ directory }), context))

		// Assert
		expect(settledMs).toBeLessThan(promptlyMs)
	})

	test('settles promptly when the run stops while the list never ends', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ list: { hang: true } })

		// Act
		const settledMs = await settleAfterStop((context) => runCheck(security({ directory }), context))

		// Assert
		expect(settledMs).toBeLessThan(promptlyMs)
	})

	test('fails when the restore fails, since nothing can be told about the packages then', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({
			restore: { exitCode: 1, stdout: 'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.' },
		})

		// Act
		const checking = runCheck(security({ directory }), toolContext())

		// Assert
		await expect(checking).rejects.toThrow('NU1301')
	})
})

describe('updatePackages', () => {
	test('moves the projects that reference a package to its version, and leaves those already at it', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ list: { stdout: referencedList } })

		// Act
		const updates = await updatePackages(
			{ directory },
			[
				{ name: 'Team.Contracts', version: '2.4.0' },
				{ name: 'Team.Other', version: '1.0.0' },
			],
			{},
			toolContext(),
		)

		// Assert
		expect(updates).toMatchObject([{ name: 'Team.Contracts', from: '2.3.0', to: '2.4.0' }])
		expect(updates[0]?.project).toContain('Api.csproj')
		const added = (await cli.calls()).filter((call) => call[0] === 'add')
		expect(added).toEqual([['add', '/work/api/src/Api.csproj', 'package', 'Team.Contracts', '--version', '2.4.0']])
	})

	test('names the projects relative to the checkout when the options name a solution', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await mkdir(path.join(directory, 'src'))
		const project = path.join(directory, 'src', 'Api', 'Api.csproj')
		const list = {
			projects: [
				{ path: project, frameworks: [{ framework: 'net10.0', topLevelPackages: [{ id: 'Team.Contracts', requestedVersion: '2.3.0' }] }] },
			],
		}
		await fakeDotnet({ list: { stdout: JSON.stringify(list) } })

		// Act
		const updates = await updatePackages(
			{ directory },
			[{ name: 'Team.Contracts', version: '2.4.0' }],
			{ target: 'src/Api.slnx' },
			toolContext(),
		)

		// Assert
		expect(updates.map((update) => update.project)).toEqual([path.join('src', 'Api', 'Api.csproj')])
	})

	test('settles promptly when the run stops while a package is being added', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ list: { stdout: referencedList }, add: { hang: true } })

		// Act
		const settledMs = await settleAfterStop((context) =>
			updatePackages({ directory }, [{ name: 'Team.Contracts', version: '2.4.0' }], {}, context),
		)

		// Assert
		expect(settledMs).toBeLessThan(promptlyMs)
	})

	test('does nothing without packages', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({})

		// Act
		const updates = await updatePackages({ directory }, [], {}, toolContext())

		// Assert
		expect(updates).toEqual([])
		expect(await cli.calls()).toEqual([])
	})
})

describe('runDotnet', () => {
	test('runs in the same directory take turns', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ build: { holdMs } })
		const started = performance.now()

		// Act
		await Promise.all([
			runDotnet(['build'], { cwd: directory, ...toolContext() }),
			runDotnet(['build'], { cwd: directory, ...toolContext() }),
		])

		// Assert
		expect(performance.now() - started).toBeGreaterThanOrEqual(2 * holdMs)
	})

	test('a run that stops while it waits its turn never runs', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ build: { holdMs } })
		const controller = new AbortController()
		const first = runDotnet(['build'], { cwd: directory, ...toolContext() })
		const second = runDotnet(['build', 'second'], { cwd: directory, abortSignal: controller.signal })

		// Act
		controller.abort(new Error('The run stopped.'))

		// Assert
		await expect(second).rejects.toThrow('The run stopped.')
		await first
		expect(await cli.calls()).toEqual([['build']])
	})

	test.skipIf(process.platform === 'win32')(
		'a stop kills what dotnet started, even what ignores it and outlives dotnet',
		async () => {
			// Arrange
			const directory = await temporaryDirectory()
			const pidFile = path.join(directory, 'child.pid')
			await fakeDotnet({ build: { hang: true, stubbornChildPidFile: pidFile } })
			const controller = new AbortController()
			const running = runDotnet(['build'], { cwd: directory, abortSignal: controller.signal })
			const child = Number(await written(pidFile))
			onTestFinished(async () => {
				if (await isRunning(child)) process.kill(child, 'SIGKILL')
			})

			// Act
			controller.abort(new Error('The run stopped.'))
			await expect(running).rejects.toThrow('The run stopped.')
			await new Promise((resolve) => setTimeout(resolve, afterForceKillMs))

			// Assert
			expect(await isRunning(child)).toBe(false)
		},
		afterForceKillMs * 2,
	)

	test.skipIf(process.platform === 'win32')(
		'a stopped run settles once dotnet is gone, even when it ignores the stop',
		async () => {
			// Arrange
			const directory = await temporaryDirectory()
			const pidFile = path.join(directory, 'dotnet.pid')
			await fakeDotnet({ build: { hang: true, ignoresStop: true, pidFile } })
			const controller = new AbortController()
			const running = runDotnet(['build'], { cwd: directory, abortSignal: controller.signal })
			const dotnet = Number(await written(pidFile))

			// Act
			controller.abort(new Error('The run stopped.'))
			await expect(running).rejects.toThrow('The run stopped.')

			// Assert
			expect(await isRunning(dotnet)).toBe(false)
		},
		afterForceKillMs * 2,
	)

	test.skipIf(process.platform === 'win32')('a dotnet killed from outside is a failed run, not an error', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ build: { killedWith: 'SIGKILL' } })

		// Act
		const result = await build({ directory }, toolContext())

		// Assert
		expect(result).toMatchObject({ succeeded: false, output: 'dotnet was killed with SIGKILL.' })
	})
})
