import { isPrompt, promptParts } from '../agent/prompt.mts'
import { exitSpec, isExit, type ExitSpec, type GateSpec } from '../exits/exit.mts'
import { isLimit, limitSpec, type LimitSpec } from '../limit/limit.mts'
import { dedentParts } from '../render/dedent.mts'
import { renderValue } from '../render/to-prompt.mts'
import { isTool, specOf, type ToolSpec } from '../tool/tool.mts'

/** A loop's template, read: the prompt text, and what the values asked for. */
export interface LoopTemplate {
	readonly text: string
	readonly tools: readonly ToolSpec[]
	/** The exits that finish the loop with a result: `succeed`, `propose`, `fail`. */
	readonly exits: readonly ExitSpec[]
	/** The gate in front of them: `verify`. */
	readonly gate: GateSpec | undefined
	readonly limit: LimitSpec | undefined
}

/** The tool name of an exit or the gate, as the agent calls it. */
export function exitName(spec: ExitSpec | GateSpec): string {
	return spec.kind
}

interface Parts {
	readonly strings: readonly string[]
	readonly values: readonly unknown[]
}

/**
 * Reads a template. Tools render as their name, exits as their tool name, a limit as its line,
 * nested prompts in place, and every other value renders itself (see `toPrompt`).
 *
 * `where` is `system` for an agent's system prompt, which may only hold tools and text: exits and
 * limits belong to a loop's own template, not to the system prompt or a prompt nested in it.
 */
export async function readTemplate(parts: Parts, where: 'loop' | 'system'): Promise<LoopTemplate> {
	const tools = new Map<string, ToolSpec>()
	const exits = new Map<string, ExitSpec>()
	let gate: GateSpec | undefined
	let limit: LimitSpec | undefined

	// Exits and limits only count in the loop's own template: that's where `loop` reads its result type from.
	const collect = ({ values }: Parts, holder: string | undefined) => {
		for (const value of values) {
			if (isPrompt(value)) collect(value[promptParts], holder ?? 'A prompt inside a loop')
			else if (isTool(value)) addTool(tools, specOf(value))
			else if (isExit(value)) {
				const spec = value[exitSpec]
				if (holder !== undefined) throw new Error(`${holder} can't hold exits such as ${spec.kind}: put them in the loop's template.`)
				if (spec.kind === 'verify') {
					if (gate !== undefined && gate !== spec) throw new Error('A loop takes one verify: put every check in it.')
					gate = spec
				} else {
					const known = exits.get(spec.kind)
					if (known !== undefined && known !== spec) throw new Error(`A loop takes one ${spec.kind}.`)
					exits.set(spec.kind, spec)
				}
			} else if (isLimit(value)) {
				if (holder !== undefined) throw new Error(`${holder} can't hold a limit: put it in the loop's template.`)
				if (limit !== undefined && limit !== value[limitSpec]) throw new Error('A loop takes one limit.')
				limit = value[limitSpec]
			}
		}
	}
	collect(parts, where === 'system' ? "An agent's system prompt" : undefined)
	for (const name of [...exits.keys(), ...(gate === undefined ? [] : [exitName(gate)])]) {
		if (tools.has(name)) throw new Error(`A tool is named ${name}, like the exit: rename the tool.`)
	}

	const finishes = [...exits.values()].filter((spec) => spec.kind !== 'fail').map((spec) => `\`${exitName(spec)}\``)
	const render = async (value: unknown): Promise<string> => {
		if (isPrompt(value)) return renderParts(value[promptParts])
		if (isTool(value)) return `\`${value.name}\``
		if (isExit(value)) {
			const spec = value[exitSpec]
			if (spec.kind !== 'verify' || finishes.length === 0) return `\`${exitName(spec)}\``
			return `the checks (${spec.checks.map((check) => check.name).join(', ')}), which run when you call ${finishes.join(' or ')}`
		}
		return renderValue(value)
	}
	const renderParts = async ({ strings, values }: Parts): Promise<string> => {
		const literal = dedentParts(strings)
		const rendered = await Promise.all(values.map(render))
		return literal.reduce((text, part, index) => text + part + (rendered[index] ?? ''), '')
	}

	return { text: await renderParts(parts), tools: [...tools.values()], exits: [...exits.values()], gate, limit }
}

/** The tools of a loop and its agent's system prompt, once each. Two different tools can't share a name. */
export function uniqueTools(specs: readonly ToolSpec[]): ToolSpec[] {
	const tools = new Map<string, ToolSpec>()
	for (const spec of specs) addTool(tools, spec)
	return [...tools.values()]
}

function addTool(tools: Map<string, ToolSpec>, spec: ToolSpec): void {
	const known = tools.get(spec.name)
	if (known !== undefined && known !== spec)
		throw new Error(`Two different tools are named ${spec.name} in one loop or its agent's system prompt: rename one.`)
	tools.set(spec.name, spec)
}
