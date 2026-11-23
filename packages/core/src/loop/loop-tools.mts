import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { renderValue } from '../render/to-prompt.mts'
import { callOutcome } from '../run/call-outcome.mts'
import { describeError } from '../run/describe-error.mts'
import { emitEvent, inEventOf } from '../run/run-events.mts'
import { untilAborted } from '../run/until-aborted.mts'
import { toolParameters } from '../tool/json-schema.mts'
import { ToolInputError, type ToolOutcome, type ToolSpec } from '../tool/tool.mts'
import type { LoopSession } from './loop-session.mts'
import { endingErrorResult, errorResult, textResult } from './tool-result.mts'

/**
 * A tool as the agent gets it. Input that doesn't fit its schema goes back to the agent to fix. A
 * throw ends the loop with that error after this round: errors bail, they don't go back to the
 * agent ([design section 6](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#6-failure-and-cancellation)).
 */
export function agentTool(spec: ToolSpec, session: LoopSession): ToolRegistration {
	const { parameters, unwrap } = toolParameters(spec.input)
	return {
		name: spec.name,
		description: spec.description ?? spec.name,
		parameters,
		execute: async (toolArguments, _api, context) => {
			const { result } = await inEventOf(
				session.scope,
				'tool-call',
				{ tool: spec.name, from: 'agent', input: toolArguments },
				(scope) => {
					const abortSignal =
						context.abortSignal === undefined ? session.abortSignal : AbortSignal.any([session.abortSignal, context.abortSignal])
					return callForAgent(spec, unwrap(toolArguments), abortSignal, (error) => {
						emitEvent(scope, 'tool-error', { error: describeError(error) })
						session.finish({ kind: 'error', error }, 'round')
						return endingErrorResult(spec.name, error)
					})
				},
				// Only a call that returned has an outcome: an input the agent must fix, or a bail, doesn't.
				({ outcome }) => (outcome === undefined ? {} : callOutcome(outcome)),
			)
			return result
		},
	}
}

/** What a call gives the agent, and what it returned when it did. */
interface AgentCall {
	readonly result: ToolExecutionResult
	readonly outcome?: ToolOutcome<unknown>
}

/** Runs one call of the agent's: an input that doesn't fit goes back to the agent, any other throw goes to `bail`. */
async function callForAgent(
	spec: ToolSpec,
	input: unknown,
	abortSignal: AbortSignal,
	bail: (error: unknown) => ToolExecutionResult,
): Promise<AgentCall> {
	let action: ReturnType<ToolSpec['prepare']>
	try {
		action = spec.prepare(input)
	} catch (error) {
		if (error instanceof ToolInputError) return { result: errorResult(`${error.message}\nFix the input and call ${spec.name} again.`) }
		return { result: bail(error) }
	}
	try {
		const outcome = await untilAborted(action({ abortSignal }), abortSignal)
		return { result: textResult(await renderValue(outcome.output)), outcome }
	} catch (error) {
		// Also a bad input of a tool the action calls: that's the action failing, not the agent's mistake.
		return { result: bail(error) }
	}
}
