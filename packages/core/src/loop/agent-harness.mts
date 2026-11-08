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
import { z } from 'zod'
import { settledWithin } from '../run/settled-within.mts'
import { resolveModel } from './resolve-model.mts'

/**
 * The run's Pi Durable harness: one store for every agent conversation in the run, one conversation
 * per loop, keyed by its call site and name.
 */
export interface AgentHarness {
	/** The conversation for a loop's store key (its key and fingerprint), made on first use, then configured with `agent`. */
	conversation(key: string, agent: AgentChange, signal: AbortSignal): Promise<Conversation>
	/** The result a loop's store key finished with in an earlier attempt of the run, if it finished. */
	keptResult(key: string, signal: AbortSignal): Promise<StoredResult | undefined>
	/** Keeps the result a loop's store key finished with, so a rerun returns it without running the loop again. */
	keepResult(key: string, result: StoredResult, signal: AbortSignal): Promise<void>
	/** Which provider serves a model id, model first. */
	model(modelId: string): ModelRef
	/** Adds a loop's tools and hooks. Conversations select it in their `agent`. */
	install(extension: Extension): void
	/** Removes a loop's tools and hooks once its conversation is done with them. */
	uninstall(extension: Extension): void
	/** A Pi context that stops waiting when `signal` aborts. */
	context(signal: AbortSignal): Context
	/** Closes the store. Gives up after `timeoutMs` when running work doesn't stop. */
	close(timeoutMs: number): Promise<void>
}

/** A loop's result as the store keeps it: its value as JSON, or the loop's workspace folder. */
const StoredResult = z.union([z.object({ folder: z.literal(true) }), z.object({ value: z.json().optional() })])
export type StoredResult = z.infer<typeof StoredResult>

export interface AgentHarnessOptions {
	readonly models: Models
	/** The agents' working directory: the run's workspace. */
	readonly workspace: string
	/** A SQLite file for the store. In memory without one. */
	readonly store: string | undefined
	readonly onReport: (report: Report) => void
}

/** Which conversation belongs to which store key, and the results of the loops that finished, as JSON text. */
const LoopRecords = defineDoc<{ byKey: Record<string, ConversationId>; results: Record<string, string> }>({
	kind: 'mesh-flow.loop-records',
	version: 1,
	scope: 'session',
	initial: () => ({ byKey: {}, results: {} }),
	checkpointWhen: () => false,
})

/**
 * Opens the harness. Every conversation gets Pi's coding tools (`read`, `write`, `edit`, `bash`) in
 * the workspace. There is no compaction: a loop that hits the context limit fails
 * ([design: Context](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#context)).
 */
export async function openAgentHarness(options: AgentHarnessOptions, runSignal: AbortSignal): Promise<AgentHarness> {
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
		context(runSignal),
	)
	await stopLeftoverWork(harness, runSignal)

	return {
		async conversation(key, agent, signal) {
			const id = await harness.commit(async (tx) => {
				const loops = await tx.doc(LoopRecords)
				const known = loops.byKey[key]
				if (known !== undefined) return known
				const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
				loops.byKey[key] = created.id
				return created.id
			}, context(signal))
			const conversation = await harness.conversation(id, context(signal))
			if (conversation === undefined) throw new Error(`The conversation of loop ${key} is gone from the agent store.`)
			await conversation.configure(agent, context(signal))
			return conversation
		},
		async keptResult(key, signal) {
			const text = await harness.commit(async (tx) => (await tx.doc(LoopRecords)).results[key], context(signal))
			return text === undefined ? undefined : StoredResult.parse(JSON.parse(text))
		},
		async keepResult(key, result, signal) {
			await harness.commit(async (tx) => {
				const loops = await tx.doc(LoopRecords)
				loops.results[key] = JSON.stringify(result)
			}, context(signal))
		},
		model: (modelId) => resolveModel(options.models, modelId),
		install: (extension) => {
			registry.install(extension)
		},
		uninstall: (extension) => {
			registry.uninstall(extension)
		},
		context,
		async close(timeoutMs) {
			await settledWithin(harness.close(BACKGROUND_CONTEXT), timeoutMs)
		},
	}
}

/**
 * Stops what an earlier attempt of the run left running in the store, such as a model request cut
 * off by a crash. It belongs to a loop that isn't running, so it would run without that loop's
 * tools, limits and events. The transcripts stay, so a loop that runs again goes on from them.
 */
async function stopLeftoverWork(harness: Harness, signal: AbortSignal): Promise<void> {
	// Copied inside the commit: the document is only readable there. A loop that finished can still have
	// left work running, when the run crashed before ending the agent's run reached the store.
	const ids = await harness.commit(async (tx) => Object.values((await tx.doc(LoopRecords)).byKey), context(signal))
	for (const id of ids) {
		await (await harness.conversation(id, context(signal)))?.abort(context(signal))
	}
}

/** A Pi context that stops waiting when `signal` aborts. Pi's waits stop; the work behind them doesn't. */
function context(signal: AbortSignal): Context {
	return withAbortSignal(signal, BACKGROUND_CONTEXT)
}

async function openStorage(file: string | undefined) {
	if (file === undefined) return new MemoryStorage()
	await mkdir(path.dirname(file), { recursive: true })
	return openNodeSqliteStorage(file)
}
