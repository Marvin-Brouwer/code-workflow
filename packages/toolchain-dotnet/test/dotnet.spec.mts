import { runCheck } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { build } from '../src/build/build.mts'
import { updatePackages } from '../src/packages/update-packages.mts'
import { security } from '../src/security/security.mts'
import { test as testTool } from '../src/test-run/test.mts'
import { tests } from '../src/test-run/tests-check.mts'
import { fakeDotnet } from './support/fake-dotnet.mts'
import { brokenBuild, failingTrx, passingTrx, referencedList, vulnerableList } from './support/fixtures.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** How soon a call that stopped has to settle. */
const promptlyMs = 1000

const running = () => ({ abortSignal: new AbortController().signal })

describe('build', () => {
	test('builds the directory without build servers, and hands back its errors and how many warnings it had', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ build: { stdout: brokenBuild, exitCode: 1 } })

		// Act
		const result = await build({ directory }, running())

		// Assert
		expect(result).toMatchObject({ succeeded: false, warnings: 2, errors: [{ code: 'CS1002', line: 12 }] })
		expect(await cli.calls()).toEqual([
			['build', directory, '--configuration', 'Debug', '-nologo', '-clp:NoSummary', '--disable-build-servers'],
		])
	})

	test('hands back the end of the output when the build fails without an error MSBuild names', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ build: { stdout: 'A compatible .NET SDK was not found.\n', exitCode: 145 } })

		// Act
		const result = await build({ directory }, running())

		// Assert
		expect(result).toEqual({ succeeded: false, errors: [], warnings: 0, output: 'A compatible .NET SDK was not found.' })
	})

	test('settles promptly when the call stops while the build never ends', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ build: { hang: true } })
		const controller = new AbortController()

		// Act
		const building = build({ directory }, { abortSignal: controller.signal })
		await new Promise((resolve) => setTimeout(resolve, 300))
		const started = performance.now()
		controller.abort(new Error('The run stopped.'))

		// Assert
		await expect(building).rejects.toThrow('The run stopped.')
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})
})

describe('test and tests', () => {
	test('the tool runs the tests with a filter and hands back the failures from every test project', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({ test: { exitCode: 1, trx: [failingTrx, passingTrx] } })

		// Act
		const result = await testTool({ directory, filter: 'FullyQualifiedName~Login' }, running())

		// Assert
		expect(result).toMatchObject({ succeeded: false, passed: 2, failed: 1, skipped: 1, buildErrors: [] })
		expect(result.failures.map((failure) => failure.name)).toEqual(['Api.Tests.LoginTests.SetsSameSite'])
		const [call] = await cli.calls()
		expect(call).toEqual(expect.arrayContaining(['test', directory, '--logger', 'trx', '--filter', 'FullyQualifiedName~Login']))
	})

	test('the check reports each failed test, and the build errors when it does not build', async () => {
		// Arrange
		const failing = await temporaryDirectory()
		const broken = await temporaryDirectory()

		// Act
		await fakeDotnet({ test: { exitCode: 1, trx: [failingTrx] } })
		const failures = await runCheck(tests({ directory: failing }), running())
		await fakeDotnet({ test: { exitCode: 1, stdout: brokenBuild } })
		const buildErrors = await runCheck(tests({ directory: broken }), running())

		// Assert
		expect(failures).toEqual([
			{
				source: 'test: Api.Tests.LoginTests.SetsSameSite',
				message:
					'Assert.Equal() Failure: Expected "None", Actual "Lax"\nat Api.Tests.LoginTests.SetsSameSite() in /work/api/tests/LoginTests.cs:line 21',
			},
		])
		expect(buildErrors).toEqual([{ source: 'build', message: '/work/api/src/Login.cs(12,34): CS1002: ; expected' }])
	})

	test('the check passes when every test passed', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({ test: { trx: [passingTrx] } })

		// Act
		const findings = await runCheck(tests({ directory }), running())

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
		const findings = await runCheck(security({ directory }), running())

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

	test('fails when the restore fails, since nothing can be told about the packages then', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await fakeDotnet({
			restore: { exitCode: 1, stdout: 'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.' },
		})

		// Act
		const checking = runCheck(security({ directory }), running())

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
			running(),
		)

		// Assert
		expect(updates).toMatchObject([{ name: 'Team.Contracts', from: '2.3.0', to: '2.4.0' }])
		expect(updates[0]?.project).toContain('Api.csproj')
		const added = (await cli.calls()).filter((call) => call[0] === 'add')
		expect(added).toEqual([['add', '/work/api/src/Api.csproj', 'package', 'Team.Contracts', '--version', '2.4.0']])
	})

	test('does nothing without packages', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cli = await fakeDotnet({})

		// Act
		const updates = await updatePackages({ directory }, [], running())

		// Assert
		expect(updates).toEqual([])
		expect(await cli.calls()).toEqual([])
	})
})
