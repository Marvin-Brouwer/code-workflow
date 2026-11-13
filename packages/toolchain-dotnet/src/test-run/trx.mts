import { EntityDecoder, XML } from '@nodable/entities'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'

/** A test that failed, as the test results file has it. */
export interface TestFailure {
	/** The test's full name, such as `Api.Tests.LoginTests.KeepsTheSession`. */
	readonly name: string
	readonly message: string
	readonly stackTrace?: string
}

/** What a test run came to, from its results files. */
export interface TestOutcome {
	readonly passed: number
	readonly failed: number
	readonly skipped: number
	readonly failures: readonly TestFailure[]
}

/** Elements that can come once or many times: always lists, so one test reads like many. */
const repeatableElements = new Set(['UnitTestResult', 'InnerResults'])

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	isArray: (name) => repeatableElements.has(name),
	parseAttributeValue: false,
	// A message such as `007` stays text.
	parseTagValue: false,
	trimValues: false,
	// XML's own entities, and character references: TRX writes each carriage return in a message or stack trace as `&#xD;`.
	entityDecoder: new EntityDecoder({ namedEntities: XML, numericAllowed: true }),
})

/** Text that may be missing, an element's text, or text with attributes beside it. */
const Text = z
	.union([z.string(), z.object({ '#text': z.string().optional() })])
	.optional()
	.transform((value) => (typeof value === 'object' ? (value['#text'] ?? '') : (value ?? '')))

/** A test's result as the TRX file has it, with the rows of a data-driven test inside it. */
interface UnitTestResult {
	readonly testName: string
	readonly outcome: string
	readonly Output?: { readonly ErrorInfo?: { readonly Message: string; readonly StackTrace: string } | undefined } | undefined
	/** The results of each data row of a data-driven test, which carry the errors the test itself may not. */
	readonly InnerResults?: readonly { readonly UnitTestResult?: readonly UnitTestResult[] | undefined }[] | undefined
}

const UnitTestResult: z.ZodType<UnitTestResult> = z.lazy(() =>
	z.object({
		testName: z.string(),
		outcome: z.string(),
		Output: z.object({ ErrorInfo: z.object({ Message: Text, StackTrace: Text }).optional() }).optional(),
		InnerResults: z.array(z.object({ UnitTestResult: z.array(UnitTestResult).optional() })).optional(),
	}),
)

/** Outcomes that aren't a failure: the test passed, or didn't run. Any other, such as `Timeout` or `Aborted`, is one. */
const notFailedOutcomes = new Set(['Passed', 'NotExecuted', 'Inconclusive'])

/** The failures of a result: those of its data rows when it has them, else its own. */
function failuresOf(result: UnitTestResult): TestFailure[] {
	if (notFailedOutcomes.has(result.outcome)) return []
	const rows = (result.InnerResults ?? []).flatMap((inner) => inner.UnitTestResult ?? []).flatMap(failuresOf)
	if (rows.length > 0) return rows
	const error = result.Output?.ErrorInfo
	const message = error?.Message.trim() ?? ''
	return [
		{
			name: result.testName,
			// A test that timed out or was aborted may say nothing more than its outcome.
			message: message === '' ? result.outcome : message,
			...(error === undefined || error.StackTrace.trim() === '' ? {} : { stackTrace: error.StackTrace.trim() }),
		},
	]
}

const Trx = z.object({
	TestRun: z.object({
		Results: z.object({ UnitTestResult: z.array(UnitTestResult).default([]) }).optional(),
		ResultSummary: z
			.object({
				Counters: z
					.object({
						passed: z.coerce.number().default(0),
						failed: z.coerce.number().default(0),
						error: z.coerce.number().default(0),
						timeout: z.coerce.number().default(0),
						aborted: z.coerce.number().default(0),
						notExecuted: z.coerce.number().default(0),
					})
					.optional(),
			})
			.optional(),
	}),
})

/** The counts and failures of one or more test results files (TRX), one per test project. */
export function outcomeOf(files: readonly string[]): TestOutcome {
	let passed = 0
	let failed = 0
	let skipped = 0
	const failures: TestFailure[] = []
	for (const file of files) {
		const { TestRun: run } = Trx.parse(parser.parse(file))
		const counters = run.ResultSummary?.Counters
		passed += counters?.passed ?? 0
		// A test that errored, timed out or was aborted failed too: TRX counts each apart.
		failed += (counters?.failed ?? 0) + (counters?.error ?? 0) + (counters?.timeout ?? 0) + (counters?.aborted ?? 0)
		skipped += counters?.notExecuted ?? 0
		failures.push(...(run.Results?.UnitTestResult ?? []).flatMap(failuresOf))
	}
	return { passed, failed, skipped, failures }
}
