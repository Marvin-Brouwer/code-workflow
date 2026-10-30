/**
 * The whole authoring vocabulary of the engine. Everything else is plain TypeScript.
 */
import type { z } from 'zod';

// ─── Workflows ───────────────────────────────────────────────────────────────────────────────

/** Registers a workflow. The body is ordinary async code; the name identifies its runs. */
export function workflow(name: string, body: () => Promise<void>): Workflow;

/** Asks a human for typed input. The run waits (sandbox snapshotted) until it's answered. */
export function input<Shape extends z.ZodRawShape>(
    question: string,
    fields: Shape,
): Promise<z.infer<z.ZodObject<Shape>>>;

/**
 * Runs `deliver` once per node, starting each node as soon as the nodes it depends on have
 * returned, and passes their results as `upstream`. Independent nodes run concurrently.
 * Fails up front on cycles or unknown ids; a failed node blocks its dependents only.
 */
export function inDependencyOrder<Node extends { id: string; dependsOn: readonly string[] }, Result>(
    nodes: readonly Node[],
    deliver: (node: Node, upstream: readonly Result[]) => Promise<Result>,
): Promise<Record<string, Result>>;

// ─── Agents ──────────────────────────────────────────────────────────────────────────────────

export interface Agent {
    /**
     * Runs the agent until it calls one of the exit tools interpolated in the prompt.
     * The result type is inferred from those exits; without exits, it's the agent's final text.
     * Interpolated tools are registered for this loop; other values are rendered into the prompt.
     * Backed by a Pi Durable session keyed by its call site.
     */
    loop<Values extends readonly unknown[]>(prompt: TemplateStringsArray, ...values: Values): Promise<ResultOf<Values>>;

    /** Exposes this agent as a tool for another agent, e.g. a reviewer asking a developer for a change. */
    as(name: string, options: { in?: unknown; verify?: readonly Check[] }): Tool;
}

export function agent(options: { model: string; reasoning?: 'low' | 'medium' | 'high'; system?: Prompt }): Agent;

/** A prompt with interpolated tools, for an agent's system prompt. */
export function prompt(strings: TemplateStringsArray, ...values: readonly unknown[]): Prompt;

/** Lets an agent ask the user a question mid-loop. */
export const requestUserInput: Tool;

// ─── Exit tools: gates on "may this agent finish?" ───────────────────────────────────────────

/** Finishes with data matching the schema. Invalid data is returned to the agent as an error. */
export function succeed(): Exit<void>;
export function succeed<T extends z.ZodTypeAny>(schema: T): Exit<z.infer<T>>;
export function succeed(folder: WorkspaceFolder): Exit<WorkspaceFolder>;

/** Finishes only after a human approves. A rejection returns the feedback to the agent. */
export function propose<T extends z.ZodTypeAny>(schema: T): Exit<z.infer<T>>;

/**
 * Finishes only when every check passes. The checks run concurrently when the agent hands in;
 * findings are returned to the agent. After `maxRejections` (default 5) the loop fails.
 */
export function verify(...checks: readonly Check[]): Exit<void>;
export function verify(options: { maxRejections: number }, ...checks: readonly Check[]): Exit<void>;

/** The agent gives up, with a reason. `loop` rejects with it. */
export const fail: Exit<never>;

// ─── Building blocks ─────────────────────────────────────────────────────────────────────────

/** A capability an agent can call. Primitives and connectors export these next to plain functions. */
export function tool<Input extends z.ZodTypeAny, Output>(
    name: string,
    definition: { description?: string; input: Input; action: (input: z.infer<Input>) => Promise<Output> },
): Tool;

/** A lazy check: describes what to verify, runs only when `verify` asks for it. */
export function check(name: string, run: () => Promise<readonly Finding[]>): Check;

export interface Finding { source: string; message: string }

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
export const workspace: {
    file(path: string): WorkspaceFile;
    folder(path: string, options?: { description?: string; minFiles?: number }): WorkspaceFolder;
};

export interface WorkspaceFile { readonly kind: 'file'; readonly path: string; append(entry: object): Promise<void> }
export interface WorkspaceFolder { readonly kind: 'folder'; readonly path: string; files(): Promise<readonly WorkspaceFile[]> }

// Opaque types
export interface Workflow { readonly name: string }
export interface Tool { readonly name: string }
export interface Check { readonly name: string }
export interface Prompt { readonly kind: 'prompt' }
export interface Exit<T> { readonly kind: 'exit'; readonly result?: T }
type ResultOf<Values extends readonly unknown[]> = Extract<Values[number], Exit<unknown>> extends Exit<infer T> ? T : string;
