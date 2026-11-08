import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { z } from 'zod'
import type { ExitSpec } from '../exits/exit.mts'
import { counted } from '../render/counted.mts'
import { renderValue } from '../render/to-prompt.mts'
import { describeError } from '../run/describe-error.mts'
import { inEventOf } from '../run/run-events.mts'
import { toolParameters } from '../tool/json-schema.mts'
import type { WorkspaceFolder } from '../workspace/workspace-folder.mts'
import { input } from '../workflow/input.mts'
import { findingsText, type RunGate, type Verdict } from './run-gate.mts'
import { AgentGaveUp } from './loop-errors.mts'
import type { LoopSession } from './loop-session.mts'
import { errorResult, finalResult, textResult } from './tool-result.mts'

/** The agent's tools for a loop's exits. `gate` runs before an exit lets the agent finish. */
export function exitTools(exits: readonly ExitSpec[], gate: RunGate, session: LoopSession): ToolRegistration[] {
	return exits.map((spec) => {
		if (spec.kind === 'propose') return proposeTool(spec.schema, gate, session)
		if (spec.kind === 'fail') return failTool(session)
		return spec.folder === undefined ? succeedTool(spec.schema, gate, session) : folderTool(spec.folder, gate, session)
	})
}

/** `verify` alone: the agent hands in, and finishes once the checks pass. */
export function verifyTool(checks: readonly string[], gate: RunGate, session: LoopSession): ToolRegistration {
	return exitTool(
		'verify',
		`Hand in your work. The checks (${checks.join(', ')}) run; when they all pass the task is done, otherwise you get what they found to fix.`,
		{ type: 'object', properties: {} },
		session,
		() => handIn(gate, session, async () => undefined),
	)
}

function succeedTool(schema: z.ZodType | undefined, gate: RunGate, session: LoopSession): ToolRegistration {
	const { parameters, unwrap } = toolParameters(schema)
	const description =
		schema === undefined
			? 'Finish the task, once the work is done.'
			: 'Finish the task with its result, once the work is done. The arguments are the result.'
	return exitTool('succeed', description, parameters, session, (args) => {
		if (schema === undefined) return handIn(gate, session, async () => undefined)
		const parsed = schema.safeParse(unwrap(args))
		if (!parsed.success)
			return Promise.resolve(errorResult(`The result doesn't fit:\n${z.prettifyError(parsed.error)}\nFix it and call succeed again.`))
		return handIn(gate, session, async () => parsed.data)
	})
}

function folderTool(folder: WorkspaceFolder, gate: RunGate, session: LoopSession): ToolRegistration {
	const minFiles = folder.options.minFiles ?? 0
	return exitTool(
		'succeed',
		`Finish the task, once ${folder.path}/ holds your work${minFiles > 0 ? ` (at least ${counted(minFiles, 'file')})` : ''}.`,
		{ type: 'object', properties: {} },
		session,
		async () => {
			const files = await folder.files()
			if (files.length < minFiles)
				return errorResult(`${folder.path}/ has ${files.length} of the ${minFiles} files it needs. Write them, then call succeed again.`)
			return handIn(gate, session, async () => folder)
		},
	)
}

function proposeTool(schema: z.ZodType, gate: RunGate, session: LoopSession): ToolRegistration {
	const { parameters, unwrap } = toolParameters(schema)
	const description =
		'Propose your result to a human. The arguments are the proposal. Approved, the task is done. Rejected, you get their feedback: revise and propose again.'
	return exitTool('propose', description, parameters, session, async (args) => {
		const parsed = schema.safeParse(unwrap(args))
		if (!parsed.success) return errorResult(`The proposal doesn't fit:\n${z.prettifyError(parsed.error)}\nFix it and propose again.`)
		const verdict = await gate()
		if (!verdict.passed) return rejectedResult(verdict)
		const answer = await input(`Approve this proposal?\n\n${await renderValue(parsed.data)}`, {
			approved: z.boolean().describe('Whether the proposal is approved'),
			feedback: z.string().optional().describe('What to change, when it is not approved'),
		})
		if (!answer.approved)
			return textResult(`The proposal was rejected. Feedback: ${answer.feedback ?? 'none given'}\nRevise it and propose again.`)
		session.finish({ kind: 'result', value: parsed.data }, 'round')
		return finalResult(textResult('The proposal was approved. The task is done.'))
	})
}

function failTool(session: LoopSession): ToolRegistration {
	return exitTool(
		'fail',
		"Give up on the task, with the reason. Only when it can't be done.",
		toolParameters(z.object({ reason: z.string().describe('Why the task cannot be done') })).parameters,
		session,
		async (args) => {
			const reason = typeof args === 'object' && args !== null && 'reason' in args ? String(args.reason) : 'no reason given'
			session.finish({ kind: 'error', error: new AgentGaveUp(reason) }, 'round')
			return finalResult(textResult('Understood. The task ends here.'))
		},
	)
}

/** Lets the agent finish with `result` once the gate passes. */
async function handIn(gate: RunGate, session: LoopSession, result: () => Promise<unknown>): Promise<ToolExecutionResult> {
	const verdict = await gate()
	if (!verdict.passed) return rejectedResult(verdict)
	session.finish({ kind: 'result', value: await result() }, 'round')
	return finalResult(textResult('Done. The task is finished.'))
}

/** What the agent gets when the checks reject its hand-in: the findings, and the end of its run after the last rejection. */
function rejectedResult(verdict: Extract<Verdict, { passed: false }>): ToolExecutionResult {
	return verdict.last ? finalResult(errorResult(findingsText(verdict))) : errorResult(findingsText(verdict))
}

function exitTool(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	session: LoopSession,
	execute: (args: unknown) => Promise<ToolExecutionResult>,
): ToolRegistration {
	return {
		name,
		description,
		parameters,
		// Never run twice: a hand-in may ask a human.
		replay: 'unsafe',
		executionMode: 'sequential',
		execute: (args) =>
			inEventOf(session.scope, 'exit-call', { exit: name, input: args }, async () => {
				try {
					return await execute(args)
				} catch (error) {
					// A check, a folder listing or a human wait that throws fails the loop, like any tool's throw.
					session.finish({ kind: 'error', error }, 'round')
					return finalResult(errorResult(`${name} failed, which ends this task: ${describeError(error)}`))
				}
			}),
	}
}
