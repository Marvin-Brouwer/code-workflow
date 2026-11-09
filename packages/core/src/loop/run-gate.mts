import { findingLines, runCheck, type Finding } from '../check/check.mts'
import type { GateSpec } from '../exits/exit.mts'
import { emitEvent, inEventOf } from '../run/run-events.mts'
import { ChecksFailed } from './loop-errors.mts'
import type { LoopSession } from './loop-session.mts'

/** What a hand-in got from the gate. */
export type Verdict = { readonly passed: true } | { readonly passed: false; readonly findings: readonly Finding[]; readonly last: boolean }

/** Runs a loop's `verify` gate: every check at once, counting rejections up to `maxRejections`. */
export type RunGate = () => Promise<Verdict>

/** A gate for the loop. Without a `verify`, every hand-in passes. */
export function runGateOf(spec: GateSpec | undefined, session: LoopSession): RunGate {
	if (spec === undefined) return async () => ({ passed: true })
	let rejections = 0
	return () =>
		inEventOf(session.scope, 'checks', { checks: spec.checks.map((check) => check.name) }, async (scope) => {
			const results = await Promise.all(spec.checks.map((check) => runCheck(check, { abortSignal: session.abortSignal })))
			const findings = results.flat()
			if (findings.length === 0) return { passed: true }
			rejections++
			emitEvent(scope, 'checks-rejected', { rejection: rejections, findings })
			const last = rejections >= spec.maxRejections
			if (last) session.finish({ kind: 'error', error: new ChecksFailed(rejections, findings) }, 'round')
			return { passed: false, findings, last }
		})
}

/** Findings as the agent reads them. */
export function findingsText(verdict: Extract<Verdict, { passed: false }>): string {
	const list = findingLines(verdict.findings)
	if (verdict.last) return `The checks rejected the work again, which ends this task:\n${list}`
	return `The checks found problems. Fix them and hand in again:\n${list}`
}
