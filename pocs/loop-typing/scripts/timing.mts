/**
 * Checks that wide templates stay cheap to type-check: one `loop` with 20 interpolated values, and
 * a file with 50 such loops. Fails on any diagnostic (such as TS2589, "type instantiation is
 * excessively deep") or when checking a file takes longer than the budget. Each case is a fresh
 * program, so its time includes checking zod and the libs; the baseline (the same file without
 * loops) shows that part. The differences are within run-to-run noise.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const budgetMs = 2000
const root = path.resolve(import.meta.dirname, '..')
const scratch = path.join(root, '.tmp')

const values = [
	'${search}',
	'${notes}',
	'${Research}',
	'${"text"}',
	'${42}',
	'${{ key: "X-1" }}',
	'${verify(tests)}',
	'${search}',
	'${notes}',
	'${Research}',
	'${"text"}',
	'${42}',
	'${{ key: "X-1" }}',
	'${verify(tests, review)}',
	'${search}',
	'${notes}',
	'${Research}',
	'${"text"}',
	'${fail}',
	'${propose(Plan)}',
]

function generate(loops: number): string {
	const calls = Array.from(
		{ length: loops },
		(_, index) => `    expectTypeOf(await agent.loop\`Loop ${String(index)}: ${values.join(' ')}\`).toEqualTypeOf<Plan>();`,
	)
	return [
		`import { expectTypeOf } from 'expect-type';`,
		`import { z } from 'zod';`,
		`import { type Agent, type Check, fail, propose, tool, verify, workspace } from '../src/core.mts';`,
		`declare const agent: Agent;`,
		`declare const tests: Check;`,
		`declare const review: Check;`,
		`const Plan = z.object({ path: z.string() });`,
		`type Plan = z.infer<typeof Plan>;`,
		`const Research = workspace.folder('research');`,
		`const notes = workspace.file('notes.md');`,
		`const search = tool('search', { input: z.object({ query: z.string() }), action: () => Promise.resolve([]) });`,
		`export async function wide() {`,
		...calls,
		`}`,
		'',
	].join('\n')
}

function measure(name: string, loops: number): { elapsed: number; diagnostics: readonly ts.Diagnostic[] } {
	const file = path.join(scratch, `${name}.ts`)
	writeFileSync(file, generate(loops))

	const config = ts.getParsedCommandLineOfConfigFile(
		path.join(root, 'tsconfig.json'),
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: () => undefined,
		},
	)
	if (!config) throw new Error(`Can't read tsconfig.json`)

	const program = ts.createProgram([file], config.options)
	const source = program.getSourceFile(file)
	const started = performance.now()
	const diagnostics = program.getSemanticDiagnostics(source)
	return { elapsed: performance.now() - started, diagnostics }
}

function check(name: string, loops: number, baseline: number): boolean {
	const { elapsed, diagnostics } = measure(name, loops)
	const ok = diagnostics.length === 0 && elapsed < budgetMs
	console.log(
		`${ok ? 'ok  ' : 'FAIL'} ${name}: ${String(loops)} loop(s) x ${String(values.length)} values checked in ${elapsed.toFixed(0)} ms, baseline ${baseline.toFixed(0)} ms (budget ${String(budgetMs)} ms)`,
	)
	for (const diagnostic of diagnostics) {
		console.log(`     TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
	}
	return ok
}

mkdirSync(scratch, { recursive: true })
try {
	measure('warm-up', 0) // the first program pays for loading and JIT-compiling the compiler
	const baseline = measure('baseline', 0).elapsed
	const results = [check('one-wide-loop', 1, baseline), check('fifty-wide-loops', 50, baseline)]
	if (results.includes(false)) process.exitCode = 1
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
