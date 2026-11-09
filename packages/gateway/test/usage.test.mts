import { describe, expect, test } from 'vitest'
import { modelsOfKind } from '../src/providers/model-apis.mts'
import { usageOf } from '../src/providers/usage.mts'

function model(kind: string, id: string) {
	const found = modelsOfKind(kind)?.find((offered) => offered.id === id)
	if (found === undefined) throw new Error(`pi-ai has no ${kind} model ${id}`)
	return found
}

describe('usageOf', () => {
	test("reads Anthropic's stream: input from message_start, output from the last message_delta", () => {
		// Arrange
		const body = [
			'event: message_start',
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":200,"output_tokens":1}}}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","usage":{"output_tokens":40}}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","usage":{"output_tokens":75}}',
			'',
		].join('\n')
		const opus = model('anthropic', 'claude-opus-5-5')

		// Act
		const used = usageOf(body, opus)

		// Assert
		expect(used).toMatchObject({ requests: 1, inputTokens: 1000, outputTokens: 75, cacheReadTokens: 200, cacheWriteTokens: 0 })
		expect(used.costUsd).toBeCloseTo((1000 * opus.cost.input + 75 * opus.cost.output + 200 * opus.cost.cacheRead) / 1_000_000)
	})

	test("reads OpenAI's usage chunk, without counting cached input twice", () => {
		// Arrange
		const body = [
			'data: {"choices":[{"delta":{"content":"hi"}}]}',
			'data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":100}}}',
			'data: [DONE]',
		].join('\n\n')

		// Act
		const used = usageOf(body, model('openai', 'gpt-4.1'))

		// Assert
		expect(used).toMatchObject({ inputTokens: 400, outputTokens: 20, cacheReadTokens: 100 })
	})

	test('reads a whole JSON answer', () => {
		// Arrange
		const body = JSON.stringify({ id: 'msg', usage: { input_tokens: 10, output_tokens: 5 } })

		// Act
		const used = usageOf(body, model('anthropic', 'claude-haiku-5-5'))

		// Assert
		expect(used).toMatchObject({ inputTokens: 10, outputTokens: 5 })
	})
})
