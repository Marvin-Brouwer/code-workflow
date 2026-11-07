/**
 * POC copy of `packages/core/src/index.d.ts`: the whole authoring vocabulary, types only.
 *
 * Changed from the sketch: the exit types and `ResultOf` (bottom of this file). Everything else is
 * the sketch as it was. This is a `.ts` file with `declare` statements rather than a `.d.ts`, so
 * `skipLibCheck` doesn't skip it.
 */
import type { z } from 'zod'

// ─── Workflows ───────────────────────────────────────────────────────────────────────────────

/** Registers a workflow. The body is ordinary async code; the name identifies its runs. */
export declare function workflow(name: string, body: () => Promise<void>): Workflow

/** Asks a human for typed input. The run waits (sandbox snapshotted) until it's answered. */
export declare function input<Shape extends z.ZodRawShape>(question: string, fields: Shape): Promise<z.infer<z.ZodObject<Shape>>>

/**
 * Runs `deliver` once per node, starting each node as soon as the nodes it depends on have
 * returned, and passes their results as `upstream`. Independent nodes run concurrently.
 * Fails up front on cycles or unknown ids; a failed node blocks its dependents only.
 */
export declare function inDependencyOrder<Node extends { id: string; dependsOn: readonly string[] }, Result>(
	nodes: readonly Node[],
	deliver: (node: Node, upstream: readonly Result[]) => Promise<Result>,
): Promise<Record<string, Result>>

// ─── Agents ──────────────────────────────────────────────────────────────────────────────────

export interface Agent {
	/**
	 * Runs the agent until it calls one of the exit tools interpolated in the prompt.
	 * The result type is inferred from those exits; without exits, it's the agent's final text.
	 * Interpolated tools are registered for this loop; other values are rendered into the prompt.
	 * Backed by a Pi Durable session keyed by its call site.
	 */
	loop<Values extends readonly unknown[]>(prompt: TemplateStringsArray, ...values: Values): Promise<ResultOf<Values>>

	/** Exposes this agent as a tool for another agent, e.g. a reviewer asking a developer for a change. */
	as(name: string, options: { in?: unknown; verify?: readonly Check[] }): Tool
}

export declare function agent(options: { model: string; reasoning?: 'low' | 'medium' | 'high'; system?: Prompt }): Agent

/** A prompt with interpolated tools, for an agent's system prompt. */
export declare function prompt(strings: TemplateStringsArray, ...values: readonly unknown[]): Prompt

/** Lets an agent ask the user a question mid-loop. */
export declare const requestUserInput: Tool

// ─── Exit tools: gates on "may this agent finish?" ───────────────────────────────────────────

/** Finishes with data matching the schema. Invalid data is returned to the agent as an error. */
export declare function succeed(): Exit<void>
export declare function succeed<T extends z.ZodType>(schema: T): Exit<z.infer<T>>
export declare function succeed(folder: WorkspaceFolder): Exit<WorkspaceFolder>

/** Finishes only after a human approves. A rejection returns the feedback to the agent. */
export declare function propose<T extends z.ZodType>(schema: T): Exit<z.infer<T>>

/**
 * Finishes only when every check passes. The checks run concurrently when the agent hands in;
 * findings are returned to the agent. After `maxRejections` (default 5) the loop fails.
 *
 * A gate, not a result: next to a result-bearing exit it adds nothing to the loop's result type.
 */
export declare function verify(...checks: readonly Check[]): Gate
export declare function verify(options: { maxRejections: number }, ...checks: readonly Check[]): Gate

/** The agent gives up, with a reason. `loop` rejects with it. */
export declare const fail: Exit<never>

// ─── Building blocks ─────────────────────────────────────────────────────────────────────────

/** A capability an agent can call. Primitives and connectors export these next to plain functions. */
export declare function tool<Input extends z.ZodType, Output>(
	name: string,
	definition: { description?: string; input: Input; action: (input: z.infer<Input>) => Promise<Output> },
): Tool

/** A lazy check: describes what to verify, runs only when `verify` asks for it. */
export declare function check(name: string, run: () => Promise<readonly Finding[]>): Check

export interface Finding {
	source: string
	message: string
}

/**
 * The run's workspace in the sandbox.
 *
 * Interpolated in a prompt, a workspace value renders as what an agent needs to find it:
 * - a file renders as its path;
 * - a folder renders as its path plus a listing of the files in it, e.g.
 *   "the Markdown files in research/: overview.md, repositories.md, open-questions.md".
 *
 * A folder also works as an exit schema: `succeed(folder)` lets the agent finish once the folder
 * meets its constraints, and the loop's result is the folder itself.
 */
export declare const workspace: {
	file(path: string): WorkspaceFile
	folder(path: string, options?: { description?: string; minFiles?: number }): WorkspaceFolder
}

export interface WorkspaceFile {
	readonly kind: 'file'
	readonly path: string
	append(entry: object): Promise<void>
}
export interface WorkspaceFolder {
	readonly kind: 'folder'
	readonly path: string
	files(): Promise<readonly WorkspaceFile[]>
}

// Opaque types
export interface Workflow {
	readonly name: string
}
export interface Tool {
	readonly name: string
}
export interface Check {
	readonly name: string
}
export interface Prompt {
	readonly kind: 'prompt'
}

// ─── Exit typing ─────────────────────────────────────────────────────────────────────────────

/**
 * Brands exits, so only values made by `succeed`, `propose`, `verify` and `fail` count as exits.
 * A plain object that happens to look like one (`{ kind: 'exit' }`) is rendered as text instead.
 */
declare const exitBrand: unique symbol

/** An exit that finishes the loop with a result of type `T`. */
export interface Exit<T> {
	readonly [exitBrand]: { readonly result: T }
}

/** An exit that only decides whether the agent may finish (`verify`). It carries no result. */
export interface Gate {
	readonly [exitBrand]: 'gate'
}

type IsAny<T> = 0 extends 1 & T ? true : false

/** The exits among the interpolated values. An `any` value is skipped rather than taken as an exit. */
type ExitsIn<Values extends readonly unknown[]> = {
	[Index in keyof Values]: IsAny<Values[Index]> extends true ? never : Values[Index] extends Exit<unknown> | Gate ? Values[Index] : never
}[number]

/** Distributes over a union of exits, so `Exit<A> | Exit<B>` gives `A | B`. */
type ResultOfExit<E> = E extends Exit<infer T> ? T : never

/**
 * What `loop` resolves to:
 * - no exits: the agent's final text;
 * - only gates (`verify`): nothing;
 * - otherwise: the union of the result-bearing exits' results (`fail` adds `never`, so nothing).
 */
export type ResultOf<Values extends readonly unknown[]> = [ExitsIn<Values>] extends [never]
	? string
	: // oxlint-disable-next-line typescript/no-invalid-void-type -- `loop` resolves to nothing, like `succeed()`
		[Exclude<ExitsIn<Values>, Gate>] extends [never]
		? void
		: ResultOfExit<Exclude<ExitsIn<Values>, Gate>>
