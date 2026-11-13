import { describe, expect, test } from 'vitest'
import { diagnosticLine, diagnosticsIn } from '../src/build/diagnostics.mts'
import { countsOf } from '../src/test-run/trx.mts'
import { brokenBuild, failingTrx, passingTrx } from './support/fixtures.mts'

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
		expect(diagnostics[0] === undefined ? '' : diagnosticLine(diagnostics[0])).toBe('/work/api/src/Login.cs(12,34): CS1002: ; expected')
	})
})

describe('countsOf', () => {
	test('adds up the results files of every test project, with the message and stack trace of each failure', () => {
		// Act
		const counts = countsOf([failingTrx, passingTrx])

		// Assert
		expect(counts).toEqual({
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
})
