import type { ToolRegistration } from '@earendil-works/pi-durable'
import { renderValue } from '../render/to-prompt.mts'
import { describeError } from '../run/describe-error.mts'
import { emitEvent, inEventOf } from '../run/run-events.mts'
import { untilAborted } from '../run/until-aborted.mts'
import { toolParameters } from '../tool/json-schema.mts'
import { ToolInputError, type ToolSpec } from '../tool/tool.mts'
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
		execute: (args, _api, context) =>
			inEventOf(session.scope, 'tool-call', { tool: spec.name, from: 'agent', input: args }, async (scope) => {
				const abortSignal =
					context.abortSignal === undefined ? session.abortSignal : AbortSignal.any([session.abortSignal, context.abortSignal])
				const bail = (error: unknown) => {
					emitEvent(scope, 'tool-error', { error: describeError(error) })
					session.finish({ kind: 'error', error }, 'round')
					return endingErrorResult(spec.name, error)
				}
				let action: ReturnType<ToolSpec['prepare']>
				try {
					action = spec.prepare(unwrap(args))
				} catch (error) {
					if (error instanceof ToolInputError) return errorResult(`${error.message}\nFix the input and call ${spec.name} again.`)
					return bail(error)
				}
				try {
					return textResult(await renderValue(await untilAborted(action({ abortSignal }), abortSignal)))
				} catch (error) {
					// Also a bad input of a tool the action calls: that's the action failing, not the agent's mistake.
					return bail(error)
				}
			}),
	}
}
