import type { z } from 'zod'

export interface Workflow {
	readonly name: string
}

/** Registers a workflow. The body is ordinary async code; the name identifies its runs. */
export function workflow(name: string, body: () => Promise<void>): Workflow

/** Asks a human for typed input. The run waits (sandbox snapshotted) until it's answered. */
export function input<Shape extends z.ZodRawShape>(question: string, fields: Shape): Promise<z.infer<z.ZodObject<Shape>>>

/**
 * Runs `deliver` once per node, starting each node as soon as the nodes it depends on have
 * returned, and passes their results as `upstream`. Independent nodes run concurrently.
 * Fails up front on cycles or unknown ids; a failed node blocks its dependents only.
 */
export function inDependencyOrder<Node extends { id: string; dependsOn: readonly string[] }, Result>(
	nodes: readonly Node[],
	deliver: (node: Node, upstream: readonly Result[]) => Promise<Result>,
): Promise<Record<string, Result>>
