import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { describeError } from '../run/describe-error.mts'

/** A tool result the agent reads as text. */
export function textResult(text: string): ToolExecutionResult {
	return { output: [{ type: 'text', text }] }
}

/** A result that tells the agent something went wrong and it can try again. */
export function errorResult(text: string): ToolExecutionResult {
	return { output: [{ type: 'text', text }], isError: true }
}

/** A result that ends the agent's run after this tool round. */
export function finalResult(result: ToolExecutionResult): ToolExecutionResult {
	return { ...result, control: { terminate: true } }
}

/** A tool's or an exit's failure as the agent reads it: the error, and the end of its run. */
export function endingErrorResult(name: string, error: unknown): ToolExecutionResult {
	return finalResult(errorResult(`${name} failed, which ends this task: ${describeError(error)}`))
}
