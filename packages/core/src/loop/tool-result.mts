import type { ToolExecutionResult } from '@earendil-works/pi-durable'

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
