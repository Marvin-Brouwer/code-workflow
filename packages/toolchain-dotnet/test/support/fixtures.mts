/** A test results file of one test project: one test passed, one failed, one skipped. */
export const failingTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="a" testName="Api.Tests.LoginTests.KeepsTheSession" outcome="Passed" />
    <UnitTestResult testId="b" testName="Api.Tests.LoginTests.SetsSameSite" outcome="Failed">
      <Output>
        <ErrorInfo>
          <Message>Assert.Equal() Failure: Expected "None", Actual "Lax"</Message>
          <StackTrace>   at Api.Tests.LoginTests.SetsSameSite() in /work/api/tests/LoginTests.cs:line 21</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
    <UnitTestResult testId="c" testName="Api.Tests.LoginTests.Later" outcome="NotExecuted" />
  </Results>
  <ResultSummary outcome="Failed">
    <Counters total="3" executed="2" passed="1" failed="1" notExecuted="1" />
  </ResultSummary>
</TestRun>
`

/** A test results file of a second test project, where everything passed. */
export const passingTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="2" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="d" testName="Api.Client.Tests.Retries" outcome="Passed" />
  </Results>
  <ResultSummary outcome="Completed">
    <Counters total="1" executed="1" passed="1" failed="0" notExecuted="0" />
  </ResultSummary>
</TestRun>
`

/** What `dotnet build` writes for a missing semicolon, once while it builds and once more for the second target framework. */
export const brokenBuild = [
	'  Determining projects to restore...',
	'/work/api/src/Login.cs(12,34): error CS1002: ; expected [/work/api/src/Api.csproj::TargetFramework=net10.0]',
	'/work/api/src/Login.cs(12,34): error CS1002: ; expected [/work/api/src/Api.csproj::TargetFramework=net10.0]',
	"/work/api/src/Login.cs(3,7): warning CS0105: The using directive for 'System' appeared previously [/work/api/src/Api.csproj]",
	'/work/api/src/Api.csproj : warning NU1603: Api depends on Polly (>= 8.0.0) but Polly 8.0.0 was not found. [/work/api/Api.sln]',
	'',
].join('\n')

/** What `dotnet list package --vulnerable --include-transitive --format json` writes for one vulnerable package, seen in two frameworks. */
export const vulnerableList = JSON.stringify({
	version: 1,
	parameters: '--vulnerable --include-transitive',
	projects: [
		{
			path: '/work/api/src/Api.csproj',
			frameworks: [
				{
					framework: 'net10.0',
					topLevelPackages: [
						{
							id: 'Newtonsoft.Json',
							requestedVersion: '12.0.1',
							resolvedVersion: '12.0.1',
							vulnerabilities: [{ severity: 'High', advisoryurl: 'https://github.com/advisories/GHSA-5crp-9r3c-p9vr' }],
						},
					],
					transitivePackages: [
						{
							id: 'System.Text.RegularExpressions',
							resolvedVersion: '4.3.0',
							vulnerabilities: [{ severity: 'High', advisoryurl: 'https://github.com/advisories/GHSA-cmhx-cq75-c4mj' }],
						},
					],
				},
				{
					framework: 'net8.0',
					topLevelPackages: [
						{
							id: 'Newtonsoft.Json',
							requestedVersion: '12.0.1',
							resolvedVersion: '12.0.1',
							vulnerabilities: [{ severity: 'High', advisoryurl: 'https://github.com/advisories/GHSA-5crp-9r3c-p9vr' }],
						},
					],
				},
			],
		},
		{ path: '/work/api/tests/Api.Tests.csproj', frameworks: [{ framework: 'net10.0', topLevelPackages: [] }] },
	],
})

/** What `dotnet list package --format json` writes for two projects that reference the upstream client. */
export const referencedList = JSON.stringify({
	version: 1,
	projects: [
		{
			path: '/work/api/src/Api.csproj',
			frameworks: [
				{ framework: 'net10.0', topLevelPackages: [{ id: 'Team.Contracts', requestedVersion: '2.3.0', resolvedVersion: '2.3.0' }] },
			],
		},
		{
			path: '/work/api/tests/Api.Tests.csproj',
			frameworks: [
				{ framework: 'net10.0', topLevelPackages: [{ id: 'team.contracts', requestedVersion: '[2.4.0]', resolvedVersion: '2.4.0' }] },
			],
		},
		{
			path: '/work/api/tools/Tool.csproj',
			frameworks: [{ framework: 'net10.0', topLevelPackages: [{ id: 'Spectre.Console', requestedVersion: '0.49.1' }] }],
		},
	],
})

/**
 * A test results file with a test that timed out, one that failed with a message that reads as a
 * number, and a data-driven test whose second row failed.
 */
export const unusualTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="3" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="e" testName="Api.Tests.SlowTests.Waits" outcome="Timeout" />
    <UnitTestResult testId="f" testName="Api.Tests.CodeTests.Pads" outcome="Failed">
      <Output><ErrorInfo><Message>007</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testId="g" testName="Api.Tests.RowTests.Adds" outcome="Failed">
      <InnerResults>
        <UnitTestResult testId="g1" testName="Api.Tests.RowTests.Adds (1, 2)" outcome="Passed" />
        <UnitTestResult testId="g2" testName="Api.Tests.RowTests.Adds (2, 2)" outcome="Failed">
          <Output><ErrorInfo><Message>Expected 4, got 5</Message></ErrorInfo></Output>
        </UnitTestResult>
      </InnerResults>
    </UnitTestResult>
  </Results>
  <ResultSummary outcome="Failed">
    <Counters total="3" executed="3" passed="0" failed="2" timeout="1" notExecuted="0" />
  </ResultSummary>
</TestRun>
`

/** A list with a vulnerable package that has neither a requested nor a resolved version. */
export const unversionedVulnerableList = JSON.stringify({
	version: 1,
	projects: [
		{
			path: '/work/api/src/Api.csproj',
			frameworks: [{ framework: 'net10.0', topLevelPackages: [{ id: 'Newtonsoft.Json', vulnerabilities: [{ severity: 'High' }] }] }],
		},
	],
})

/** A test results file as vstest writes it on Windows: each carriage return as a character reference. */
export const windowsTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="4" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="h" testName="Api.Tests.LoginTests.SetsSameSite" outcome="Failed">
      <Output><ErrorInfo><Message>Expected "None"&#xD;
Actual "Lax"</Message><StackTrace>at One() in C:\\work\\LoginTests.cs:line 21&#xD;
at Two() in C:\\work\\LoginTests.cs:line 30</StackTrace></ErrorInfo></Output>
    </UnitTestResult>
  </Results>
  <ResultSummary outcome="Failed">
    <Counters total="1" executed="1" passed="0" failed="1" />
  </ResultSummary>
</TestRun>
`

/** What `dotnet test` writes for a failed test whose message has a line that looks like an MSBuild error. */
export const failingTestOutput = [
	'  Failed Api.Tests.LoginTests.SetsSameSite [12 ms]',
	'  Error Message:',
	'   Expected: error: not found',
	'',
].join('\n')

/** What `dotnet list package --vulnerable --format json` writes when a source has no vulnerability data. */
export const auditProblemList = JSON.stringify({
	version: 1,
	parameters: '--vulnerable',
	problems: [{ level: 'warning', text: 'The source https://feed.example/v3/index.json has no vulnerability data.' }],
	projects: [{ path: '/work/api/src/Api.csproj', frameworks: [] }],
})
