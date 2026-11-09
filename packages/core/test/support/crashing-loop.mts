import { agent } from '../../src/agent/agent.mts'
import { succeed } from '../../src/exits/succeed.mts'
import { runWorkflow } from '../../src/workflow/run-workflow.mts'
import { workflow } from '../../src/workflow/workflow.mts'
import { askedMarker } from './crashing-loop-marker.mts'
import { memoryChannel } from './memory-channel.mts'
import { neverAnswers, scriptedModel } from './scripted-model.mts'

/**
 * Started as its own process by the agent store spec, which kills it: runs a loop on the store in
 * `argv[3]` whose model request never answers, and prints {@link askedMarker} once the model has the request.
 */
const [workspace, agentStore] = process.argv.slice(2)
if (workspace === undefined || agentStore === undefined) throw new Error('Pass the workspace and the agent store.')
const model = scriptedModel([
	(...request) => {
		console.log(askedMarker)
		return neverAnswers(...request)
	},
])
const helper = agent({ model: model.id })
await runWorkflow(
	workflow('store', async () => {
		await helper.loop`First task. ${succeed()}`
	}),
	{ channel: memoryChannel(), abortSignal: new AbortController().signal, workspace, agentStore, models: model.models },
)
