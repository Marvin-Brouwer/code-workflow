import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import { z } from 'zod'
import { agent } from '../src/agent/agent.mts'
import { propose } from '../src/exits/propose.mts'
import { succeed } from '../src/exits/succeed.mts'
import { runBody } from './support/run-body.mts'
import { callsTool, says, scriptedModel, slowly, textOf } from './support/scripted-model.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const Answer = z.object({ answer: z.number() })
/** How long the crashing attempt gets to store its running work after its model request went out. */
const storedWorkMs = 500
/** How long the model takes to answer the rerun's loop. */
const leftoverWindowMs = 3_000
const loader = new URL('support/protocol-from-source.mts', import.meta.url).href
const crashingLoop = path.join(import.meta.dirname, 'support/crashing-loop.mts')

/** A workspace and an agent store that several runs share, like the attempts of one run. */
async function sharedStore() {
	const workspace = await temporaryDirectory()
	return { workspace, agentStore: path.join(workspace, '.mesh-flow', 'agents.sqlite') }
}

describe('a run on an agent store an earlier attempt used', () => {
	test('returns the kept result of a loop that finished, without asking the model', async () => {
		// Arrange
		const store = await sharedStore()
		const helper = agent({ model: 'scripted-model' })
		const body = () => helper.loop`Answer. ${succeed(Answer)}`
		const first = scriptedModel([callsTool('succeed', { answer: 1 })])
		await (
			await runBody(body, { ...first, ...store })
		).result
		const second = scriptedModel([callsTool('succeed', { answer: 2 })])

		// Act
		const rerun = await runBody(body, { ...second, ...store })

		// Assert
		expect(await rerun.result).toEqual({ answer: 1 })
		expect(second.calls()).toBe(0)
		expect(rerun.channel.events.map((event) => event.type)).toContain('loop-kept')
	})

	test('does not ask the human again for a proposal they approved', async () => {
		// Arrange
		const store = await sharedStore()
		const planner = agent({ model: 'scripted-model' })
		const body = () => planner.loop`Propose with ${propose(Answer)}.`
		const first = await runBody(body, { ...scriptedModel([callsTool('propose', { answer: 1 })]), ...store })
		first.channel.reply((await first.channel.nextInput()).id, { approved: true })
		await first.result

		// Act
		const rerun = await runBody(body, { ...scriptedModel([]), ...store })

		// Assert
		expect(await rerun.result).toEqual({ answer: 1 })
		expect(rerun.channel.inputs).toEqual([])
	})

	test('stops what a crashed attempt left running, so it never runs as another loop', async () => {
		// Arrange
		const store = await sharedStore()
		const child = spawn(process.execPath, ['--import', loader, crashingLoop, store.workspace, store.agentStore], {
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		onTestFinished(() => {
			child.kill('SIGKILL')
		})
		await new Promise<void>((resolve) => {
			child.stdout.on('data', (chunk: Buffer) => {
				if (chunk.toString().includes('asked')) resolve()
			})
		})
		// Long enough for the attempt to store its running work, as a crash in the middle of a loop would leave it.
		await new Promise((resolve) => setTimeout(resolve, storedWorkMs))
		const exited = new Promise((resolve) => child.once('exit', resolve))
		child.kill('SIGKILL')
		await exited
		// Slow to answer, so leftover work that runs again has time to ask the model too.
		// A second answer for leftover work to take, if it runs.
		const model = scriptedModel([slowly(leftoverWindowMs, callsTool('succeed', { answer: 2 })), says('leftover')])
		const helper = agent({ model: model.id })

		// Act
		const rerun = await runBody(() => helper.loop`Other task. ${succeed(Answer)}`, { ...model, ...store })

		// Assert
		expect(await rerun.result).toEqual({ answer: 2 })
		expect(model.calls()).toBe(1)
		expect(textOf(model.requests[0])).toContain('Other task.')
	})
})
