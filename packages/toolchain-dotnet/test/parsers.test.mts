import { describe, expect, test } from 'vitest'
import { diagnosticLine, diagnosticsIn } from '../src/build/diagnostics.mts'
import { outcomeOf } from '../src/test-run/trx.mts'
import { brokenBuild, failingTrx, passingTrx, unusualTrx, windowsTrx } from './support/fixtures.mts'

describe('diagnosticsIn', () => {
	test("reads MSBuild's errors and warnings once each, with the file, the line and the project", () => {
		// Act
		const diagnostics = diagnosticsIn(brokenBuild)

		// Assert
		expect(diagnostics).toEqual([
			{
				severity: 'error',
				code: 'CS1002',
				message: '; expected',
				file: '/work/api/src/Login.cs',
				line: 12,
				column: 34,
				project: '/work/api/src/Api.csproj::TargetFramework=net10.0',
			},
			{
				severity: 'warning',
				code: 'CS0105',
				message: "The using directive for 'System' appeared previously",
				file: '/work/api/src/Login.cs',
				line: 3,
				column: 7,
				project: '/work/api/src/Api.csproj',
			},
			{
				severity: 'warning',
				code: 'NU1603',
				message: 'Api depends on Polly (>= 8.0.0) but Polly 8.0.0 was not found.',
				file: '/work/api/src/Api.csproj',
				project: '/work/api/Api.sln',
			},
		])
	})
})

describe('diagnosticLine', () => {
	test('writes a diagnostic as MSBuild does, with its file and position', () => {
		// Act
		const line = diagnosticLine({ severity: 'error', code: 'CS1002', message: '; expected', file: '/work/a.cs', line: 12, column: 34 })

		// Assert
		expect(line).toBe('/work/a.cs(12,34): CS1002: ; expected')
	})

	test('writes a diagnostic without a file or a line as its code and message', () => {
		// Act
		const line = diagnosticLine({ severity: 'error', code: 'MSB1003', message: 'Specify a project or solution file.' })

		// Assert
		expect(line).toBe('MSB1003: Specify a project or solution file.')
	})
})

describe('outcomeOf', () => {
	test('adds up the results files of every test project, with the message and stack trace of each failure', () => {
		// Act
		const outcome = outcomeOf([failingTrx, passingTrx])

		// Assert
		expect(outcome).toEqual({
			passed: 2,
			failed: 1,
			skipped: 1,
			failures: [
				{
					name: 'Api.Tests.LoginTests.SetsSameSite',
					message: 'Assert.Equal() Failure: Expected "None", Actual "Lax"',
					stackTrace: 'at Api.Tests.LoginTests.SetsSameSite() in /work/api/tests/LoginTests.cs:line 21',
				},
			],
		})
	})

	test("counts a timeout as failed, keeps a message that reads as a number, and takes a data-driven test's failures from its rows", () => {
		// Act
		const outcome = outcomeOf([unusualTrx])

		// Assert
		expect(outcome).toEqual({
			passed: 0,
			failed: 3,
			skipped: 0,
			failures: [
				{ name: 'Api.Tests.SlowTests.Waits', message: 'Timeout' },
				{ name: 'Api.Tests.CodeTests.Pads', message: '007' },
				{ name: 'Api.Tests.RowTests.Adds (2, 2)', message: 'Expected 4, got 5' },
			],
		})
	})

	test('reads the line breaks of a results file written on Windows', () => {
		// Act
		const { failures } = outcomeOf([windowsTrx])

		// Assert
		expect(failures).toEqual([
			{
				name: 'Api.Tests.LoginTests.SetsSameSite',
				message: 'Expected "None"\r\nActual "Lax"',
				stackTrace: 'at One() in C:\\work\\LoginTests.cs:line 21\r\nat Two() in C:\\work\\LoginTests.cs:line 30',
			},
		])
	})
})
