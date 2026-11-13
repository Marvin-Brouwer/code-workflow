import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runCheck } from '@mesh-flow/core'
import { execa } from 'execa'
import { describe, expect, test } from 'vitest'
import { build } from '../src/build/build.mts'
import { security } from '../src/security/security.mts'
import { testsPass } from '../src/test-run/tests-pass.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** Whether a .NET SDK is on the `PATH`, as on GitHub's runners: these tests need the real one. */
const hasSdk = await execa('dotnet', ['--version'], { reject: false }).then((result) => result.exitCode === 0)

/** Long enough for a first restore from nuget.org. */
const sdkTimeoutMs = 180_000

/** What a tool or check gets when called from code, with a signal nothing aborts. */
const toolContext = () => ({ abortSignal: new AbortController().signal })

/** A new project from one of the SDK's templates, in a directory of its own. */
async function newProject(template: string): Promise<string> {
	const directory = path.join(await temporaryDirectory(), 'App')
	await execa('dotnet', ['new', template, '--output', directory, '--name', 'App'], {
		env: { DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
	})
	return directory
}

describe.runIf(hasSdk)('the real SDK', () => {
	test(
		'build reports the compiler error of a broken console app on its line',
		async () => {
			// Arrange
			const directory = await newProject('console')
			await writeFile(path.join(directory, 'Program.cs'), 'Console.WriteLine("hello")\n')

			// Act
			const result = await build({ directory }, toolContext())

			// Assert
			expect(result.succeeded).toBe(false)
			expect(result.errors).toMatchObject([{ code: 'CS1002', line: 1, file: expect.stringContaining('Program.cs') as unknown }])
		},
		sdkTimeoutMs,
	)

	test(
		'tests reports the failed test of an xUnit project',
		async () => {
			// Arrange
			const directory = await newProject('xunit')
			await writeFile(
				path.join(directory, 'UnitTest1.cs'),
				'namespace App;\n\npublic class UnitTest1\n{\n\t[Fact]\n\tpublic void Adds() => Assert.Equal(3, 1 + 1);\n}\n',
			)

			// Act
			const findings = await runCheck(testsPass({ directory }), toolContext())

			// Assert
			expect(findings).toMatchObject([{ source: 'test: App.UnitTest1.Adds' }])
		},
		sdkTimeoutMs,
	)

	test(
		'tests reports the compiler error of a broken xUnit project as a build finding',
		async () => {
			// Arrange
			const directory = await newProject('xunit')
			await writeFile(
				path.join(directory, 'UnitTest1.cs'),
				'namespace App;\n\npublic class UnitTest1\n{\n\t[Fact]\n\tpublic void Adds() { }\n',
			)

			// Act
			const findings = await runCheck(testsPass({ directory }), toolContext())

			// Assert
			expect(new Set(findings.map((finding) => finding.source))).toEqual(new Set(['build']))
		},
		sdkTimeoutMs,
	)

	test(
		'security passes a fresh console app',
		async () => {
			// Arrange
			const directory = await newProject('console')

			// Act
			const findings = await runCheck(security({ directory }), toolContext())

			// Assert
			expect(findings).toEqual([])
		},
		sdkTimeoutMs,
	)
})
