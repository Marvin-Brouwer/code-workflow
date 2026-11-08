import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import { z } from 'zod'
import { agent } from '../src/agent/agent.mts'
import { propose } from '../src/exits/propose.mts'
import { succeed } from '../src/exits/succeed.mts'
import { runBody } from './support/run-body.mts'
import { askedMarker } from './support/crashing-loop-marker.mts'
import { callsTool, modelId, says, scriptedModel, slowly, textOf } from './support/scripted-model.mts'
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
		const helper = agent({ model: modelId })
		const body = () => helper.loop`Answer. ${succeed(Answer)}`
		const first = scriptedModel([callsTool('succeed', { answer: 1 })])
		const firstRun = await runBody(body, { ...first, ...store })
		await firstRun.result
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
		const planner = agent({ model: modelId })
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

	test('runs a loop again when what the agent gets changed', async () => {
		// Arrange
		const store = await sharedStore()
		const helper = agent({ model: modelId })
		const summarise = (comments: readonly string[]) => async () => {
			const summaries = []
			for (const comment of comments) summaries.push(await helper.loop`Summarise comment ${comment}.`)
			return summaries
		}
		const firstRun = await runBody(summarise(['A']), { ...scriptedModel([says('summary of A')]), ...store })
		await firstRun.result
		const second = scriptedModel([says('summary of B'), says('summary of C')])

		// Act
		const rerun = await runBody(summarise(['B', 'C']), { ...second, ...store })

		// Assert
		expect(await rerun.result).toEqual(['summary of B', 'summary of C'])
		expect(textOf(second.requests[0])).not.toContain('comment A')
	})

	test('returns a result that is not JSON, and runs that loop again on a rerun', async () => {
		// Arrange
		const store = await sharedStore()
		const helper = agent({ model: modelId })
		const Big = z.object({ answer: z.number().transform((answer) => BigInt(answer)) })
		const body = () => helper.loop`Answer. ${succeed(Big)}`
		const firstRun = await runBody(body, { ...scriptedModel([callsTool('succeed', { answer: 1 })]), ...store })
		const second = scriptedModel([callsTool('succeed', { answer: 2 })])

		// Act
		const firstResult = await firstRun.result
		const rerun = await runBody(body, { ...second, ...store })

		// Assert
		expect(firstResult).toEqual({ answer: 1n })
		expect(firstRun.channel.events.map((event) => event.type)).toContain('loop-not-kept')
		expect(await rerun.result).toEqual({ answer: 2n })
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
				if (chunk.toString().includes(askedMarker)) resolve()
			})
		})
		// Long enough for the attempt to store its running work, as a crash in the middle of a loop would leave it.
		await new Promise((resolve) => setTimeout(resolve, storedWorkMs))
		const exited = new Promise((resolve) => child.once('exit', resolve))
		child.kill('SIGKILL')
		await exited
		// Slow to answer, with a second answer queued: leftover work that runs again would show up as a second call.
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
