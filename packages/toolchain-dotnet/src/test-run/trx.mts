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
export interface TestCounts {
	readonly passed: number
	readonly failed: number
	readonly skipped: number
	readonly failures: readonly TestFailure[]
}

/** Elements that can come once or many times: always lists, so one test reads like many. */
const lists = new Set(['UnitTestResult', 'InnerResults'])

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	isArray: (name) => lists.has(name),
	parseAttributeValue: false,
	trimValues: false,
})

/** Text that may be missing, an element's text, or text with attributes beside it. */
const Text = z
	.union([z.string(), z.number(), z.object({ '#text': z.union([z.string(), z.number()]).optional() })])
	.optional()
	.transform((value) => (typeof value === 'object' ? String(value['#text'] ?? '') : value === undefined ? '' : String(value)))

const UnitTestResult = z.object({
	testName: z.string(),
	outcome: z.string(),
	Output: z.object({ ErrorInfo: z.object({ Message: Text, StackTrace: Text }).optional() }).optional(),
})

const Trx = z.object({
	TestRun: z.object({
		Results: z.object({ UnitTestResult: z.array(UnitTestResult).default([]) }).optional(),
		ResultSummary: z
			.object({
				Counters: z
					.object({ passed: z.coerce.number().default(0), failed: z.coerce.number().default(0), notExecuted: z.coerce.number().default(0) })
					.optional(),
			})
			.optional(),
	}),
})

/** The counts and failures of one or more test results files (TRX), one per test project. */
export function countsOf(files: readonly string[]): TestCounts {
	let passed = 0
	let failed = 0
	let skipped = 0
	const failures: TestFailure[] = []
	for (const file of files) {
		const { TestRun: run } = Trx.parse(parser.parse(file))
		const counters = run.ResultSummary?.Counters
		passed += counters?.passed ?? 0
		failed += counters?.failed ?? 0
		skipped += counters?.notExecuted ?? 0
		for (const result of run.Results?.UnitTestResult ?? []) {
			if (result.outcome !== 'Failed') continue
			const error = result.Output?.ErrorInfo
			failures.push({
				name: result.testName,
				message: error?.Message.trim() ?? '',
				...(error === undefined || error.StackTrace.trim() === '' ? {} : { stackTrace: error.StackTrace.trim() }),
			})
		}
	}
	return { passed, failed, skipped, failures }
}
