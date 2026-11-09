import { describe, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import { agent } from '../src/agent/agent.mts'
import { prompt } from '../src/agent/prompt.mts'
import { requestUserInput } from '../src/agent/request-user-input.mts'
import { succeed } from '../src/exits/succeed.mts'
import { limit } from '../src/limit/limit.mts'
import { toPrompt } from '../src/render/to-prompt.mts'
import { tool } from '../src/tool/tool.mts'

const helper = agent({ model: 'scripted-model' })
const readTicket = tool('readTicket', { input: z.object({ key: z.string() }), action: async ({ key }) => key })
interface Story {
	readonly key: string
	readonly labels: readonly string[]
}
const story: Story = { key: 'ABC-1', labels: ['web'] }

// Only the types are under test: these loops are never started.
const takesKnownValues = () =>
	helper.loop`Fix ${story} with ${readTicket} and ${requestUserInput}, ${1}, ${true}, ${new Date()}, ${undefined}. ${prompt`Be brief.`} ${{ [toPrompt]: () => 'a story' }} ${succeed(z.object({ done: z.boolean() }))} ${limit({ turns: 3 })}`
const refusesTheRest = () => [
	// @ts-expect-error: an await was forgotten
	helper.loop`Fix ${readTicket({ key: 'ABC-1' })}.`,
	// @ts-expect-error: a function, not a tool
	helper.loop`Fix it with ${() => 'help'}.`,
	// @ts-expect-error: a symbol
	helper.loop`Fix ${Symbol('story')}.`,
	// @ts-expect-error: system prompts are checked the same way
	prompt`Use ${readTicket({ key: 'ABC-1' })}.`,
]

describe('values in a template', () => {
	test('take tools, exits, limits, prompts, values that render themselves, primitives and plain data', () => {
		expectTypeOf(takesKnownValues).returns.resolves.toEqualTypeOf<{ done: boolean }>()
	})

	test('refuse a promise, a function that is not a tool, and a symbol', () => {
		expectTypeOf(refusesTheRest).toBeFunction()
	})
})
