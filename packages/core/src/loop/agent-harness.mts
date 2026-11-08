import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import {
	createRegistry,
	defineDoc,
	Harness,
	MemoryStorage,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type Extension,
	type ModelRef,
	type Report,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { settledWithin } from '../run/until-aborted.mts'
import { resolveModel } from './resolve-model.mts'

/**
 * The run's Pi Durable harness: one store for every agent conversation in the run, one conversation
 * per loop, keyed by its call site and name.
 */
export interface AgentHarness {
	/** The conversation for a loop key, made on first use, then configured with `agent`. */
	conversation(key: string, agent: AgentChange, signal: AbortSignal): Promise<Conversation>
	/** Which provider serves a model id, model first. */
	model(modelId: string): ModelRef
	/** Adds a loop's tools and hooks. Conversations select it in their `agent`. */
	install(extension: Extension): void
	/** A Pi context that stops waiting when `signal` aborts. */
	context(signal: AbortSignal): Context
	/** Closes the store. Gives up after `ms` when running work doesn't stop. */
	close(ms: number): Promise<void>
}

export interface AgentHarnessOptions {
	readonly models: Models
	/** The agents' working directory: the run's workspace. */
	readonly workspace: string
	/** A SQLite file for the store. In memory without one. */
	readonly store: string | undefined
	readonly onReport: (report: Report) => void
}

/** Which conversation belongs to which loop key. */
const LoopConversations = defineDoc<{ byKey: Record<string, ConversationId> }>({
	kind: 'mesh-flow.loop-conversations',
	version: 1,
	scope: 'session',
	initial: () => ({ byKey: {} }),
	checkpointWhen: () => false,
})

/**
 * Opens the harness. Every conversation gets Pi's coding tools (`read`, `write`, `edit`, `bash`) in
 * the workspace. There is no compaction: a loop that hits the context limit fails
 * ([design: Context](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#context)).
 */
export async function openAgentHarness(options: AgentHarnessOptions, signal: AbortSignal): Promise<AgentHarness> {
	const registry = createRegistry()
	registry.install(CodingTools)
	const harness = await Harness.open(
		await openStorage(options.store),
		{
			models: options.models,
			registry,
			settings: { extensions: [CodingTools], compaction: { enabled: false }, afterFailedRun: 'withdraw' },
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.workspace }),
			onReport: options.onReport,
		},
		context(signal),
	)
	harness.resume()

	return {
		async conversation(key, agent, stop) {
			const id = await harness.commit(async (tx) => {
				const loops = await tx.doc(LoopConversations)
				const known = loops.byKey[key]
				if (known !== undefined) return known
				const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
				loops.byKey[key] = created.id
				return created.id
			}, context(stop))
			const conversation = await harness.conversation(id, context(stop))
			if (conversation === undefined) throw new Error(`The conversation of loop ${key} is gone from the agent store.`)
			await conversation.configure(agent, context(stop))
			return conversation
		},
		model: (modelId) => resolveModel(options.models, modelId),
		install: (extension) => {
			registry.install(extension)
		},
		context,
		async close(ms) {
			await settledWithin(harness.close(BACKGROUND_CONTEXT), ms)
		},
	}
}

/** A Pi context that stops waiting when `stop` aborts. Pi's waits stop; the work behind them doesn't. */
function context(stop: AbortSignal): Context {
	return withAbortSignal(stop, BACKGROUND_CONTEXT)
}

async function openStorage(file: string | undefined) {
	if (file === undefined) return new MemoryStorage()
	await mkdir(path.dirname(file), { recursive: true })
	return openNodeSqliteStorage(file)
}
