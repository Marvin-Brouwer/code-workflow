import { describeError } from '../run/describe-error.mts'
import { emitEvent, inEvent, inEventOf } from '../run/run-events.mts'

/** A node for {@link inDependencyOrder}: an id and the ids it waits for. */
export interface DependencyNode {
	readonly id: string
	readonly dependsOn: readonly string[]
}

/** Some nodes failed. The others ran as far as they could. */
export class DependencyOrderFailed<Result> extends Error {
	override readonly name = 'DependencyOrderFailed'
	/** The results of the nodes that returned. */
	readonly results: Readonly<Record<string, Result>>
	/** The errors of the nodes that threw. */
	readonly failed: Readonly<Record<string, unknown>>
	/** The nodes that didn't run, because a node they depend on failed. */
	readonly blocked: readonly string[]

	constructor(results: Record<string, Result>, failed: Record<string, unknown>, blocked: readonly string[]) {
		const failures = Object.entries(failed).map(([id, error]) => `${id}: ${describeError(error)}`)
		super(
			`${failures.length} of the nodes failed${blocked.length === 0 ? '' : `, which blocked ${blocked.join(', ')}`}.\n${failures.join('\n')}`,
		)
		this.results = results
		this.failed = failed
		this.blocked = blocked
	}
}

/** A node didn't run, because one it depends on failed. */
class Blocked extends Error {}

/**
 * Runs `deliver` once per node, starting each node as soon as the nodes it depends on have returned,
 * and passes their results as `upstream`, in `dependsOn` order. Independent nodes run concurrently.
 *
 * ```ts
 * await inDependencyOrder(deliveryOrder(plan), async (part, upstream) => {
 * 	const repository = await gitlab.checkout(part.repository)
 * 	// ...
 * 	return { packages: await gitlab.publishedPackages(mergeRequest, 'nuget') }
 * })
 * ```
 *
 * Throws up front on duplicate or unknown ids and on cycles. A failed node blocks only the nodes that
 * depend on it; the others go on. When any node failed, it rejects with a `DependencyOrderFailed`
 * that holds every result, failure and blocked node. Each node's loops are keyed by its id.
 */
export async function inDependencyOrder<Node extends DependencyNode, Result>(
	nodes: readonly Node[],
	deliver: (node: Node, upstream: readonly Result[]) => Promise<Result>,
): Promise<Record<string, Result>> {
	const byId = indexNodes(nodes)
	return inEvent('in-dependency-order', { nodes: nodes.map(({ id, dependsOn }) => ({ id, dependsOn })) }, async (scope) => {
		const started = new Map<string, Promise<Result>>()
		const start = (node: Node): Promise<Result> => {
			const known = started.get(node.id)
			if (known !== undefined) return known
			const running = (async () => {
				const upstream = await Promise.all(node.dependsOn.map((id) => start(nodeOf(byId, id)))).catch(() => {
					throw new Blocked()
				})
				const nodeScope = { ...scope, names: [...scope.names, node.id] }
				return inEventOf(nodeScope, 'node', { node: node.id }, () => deliver(node, upstream))
			})()
			started.set(node.id, running)
			return running
		}
		const settled = await Promise.allSettled(nodes.map(start))

		const results: Record<string, Result> = {}
		const failed: Record<string, unknown> = {}
		const blocked: string[] = []
		nodes.forEach(({ id }, index) => {
			const outcome = settled[index]
			if (outcome === undefined) return
			if (outcome.status === 'fulfilled') results[id] = outcome.value
			else if (outcome.reason instanceof Blocked) blocked.push(id)
			else failed[id] = outcome.reason
		})
		if (blocked.length > 0) emitEvent(scope, 'nodes-blocked', { nodes: blocked })
		if (Object.keys(failed).length > 0) throw new DependencyOrderFailed(results, failed, blocked)
		return results
	})
}

/** Checks the graph before anything runs: unique ids, known dependencies, no cycles. */
function indexNodes<Node extends DependencyNode>(nodes: readonly Node[]): Map<string, Node> {
	const byId = new Map<string, Node>()
	for (const node of nodes) {
		if (byId.has(node.id)) throw new Error(`Node ${node.id} is in the list twice.`)
		byId.set(node.id, node)
	}
	for (const node of nodes) {
		for (const id of node.dependsOn) if (!byId.has(id)) throw new Error(`Node ${node.id} depends on ${id}, which isn't in the list.`)
	}
	const done = new Set<string>()
	const visit = (node: Node, path: readonly string[]) => {
		if (path.includes(node.id)) throw new Error(`The nodes depend on each other in a cycle: ${[...path, node.id].join(' → ')}.`)
		if (done.has(node.id)) return
		for (const id of node.dependsOn) visit(nodeOf(byId, id), [...path, node.id])
		done.add(node.id)
	}
	for (const node of nodes) visit(node, [])
	return byId
}

function nodeOf<Node extends DependencyNode>(byId: ReadonlyMap<string, Node>, id: string): Node {
	const node = byId.get(id)
	if (node === undefined) throw new Error(`Node ${id} isn't in the list.`)
	return node
}
