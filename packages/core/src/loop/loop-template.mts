import { isPrompt, promptParts } from '../agent/prompt.mts'
import { exitSpecification, isExit, type ExitSpecification, type GateSpecification } from '../exits/exit.mts'
import { isLimit, limitSpecification, type LimitSpecification } from '../limit/limit.mts'
import { dedentParts } from '../render/dedent.mts'
import { renderValue } from '../render/to-prompt.mts'
import { isTool, specificationOf, type ToolSpecification } from '../tool/tool.mts'

/** A loop's template, read: the prompt text, and what the values asked for. */
export interface LoopTemplate {
	readonly text: string
	readonly tools: readonly ToolSpecification[]
	/** The exits that finish the loop with a result: `succeed`, `propose`, `fail`. */
	readonly exits: readonly ExitSpecification[]
	/** The gate in front of them: `verify`. */
	readonly gate: GateSpecification | undefined
	readonly limit: LimitSpecification | undefined
}

/** The tool name of an exit or the gate, as the agent calls it. */
export function exitName(specification: ExitSpecification | GateSpecification): string {
	return specification.kind
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
	const tools = new Map<string, ToolSpecification>()
	const exits = new Map<string, ExitSpecification>()
	let gate: GateSpecification | undefined
	let limit: LimitSpecification | undefined

	// Exits and limits only count in the loop's own template: that's where `loop` reads its result type from.
	const collect = ({ values }: Parts, holder: string | undefined) => {
		for (const value of values) {
			if (isPrompt(value)) collect(value[promptParts], holder ?? 'A prompt inside a loop')
			else if (isTool(value)) addTool(tools, specificationOf(value))
			else if (isExit(value)) {
				const specification = value[exitSpecification]
				if (holder !== undefined)
					throw new Error(`${holder} can't hold exits such as ${specification.kind}: put them in the loop's template.`)
				if (specification.kind === 'verify') {
					if (gate !== undefined && gate !== specification) throw new Error('A loop takes one verify: put every check in it.')
					gate = specification
				} else {
					const known = exits.get(specification.kind)
					if (known !== undefined && known !== specification) throw new Error(`A loop takes one ${specification.kind}.`)
					exits.set(specification.kind, specification)
				}
			} else if (isLimit(value)) {
				if (holder !== undefined) throw new Error(`${holder} can't hold a limit: put it in the loop's template.`)
				if (limit !== undefined && limit !== value[limitSpecification]) throw new Error('A loop takes one limit.')
				limit = value[limitSpecification]
			}
		}
	}
	collect(parts, where === 'system' ? "An agent's system prompt" : undefined)
	for (const name of [...exits.keys(), ...(gate === undefined ? [] : [exitName(gate)])]) {
		if (tools.has(name)) throw new Error(`A tool is named ${name}, like the exit: rename the tool.`)
	}

	const finishes = [...exits.values()]
		.filter((specification) => specification.kind !== 'fail')
		.map((specification) => `\`${exitName(specification)}\``)
	const render = async (value: unknown): Promise<string> => {
		if (isPrompt(value)) return renderParts(value[promptParts])
		if (isTool(value)) return `\`${value.name}\``
		if (isExit(value)) {
			const specification = value[exitSpecification]
			if (specification.kind !== 'verify' || finishes.length === 0) return `\`${exitName(specification)}\``
			return `the checks (${specification.checks.map((check) => check.name).join(', ')}), which run when you call ${finishes.join(' or ')}`
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
export function uniqueTools(specifications: readonly ToolSpecification[]): ToolSpecification[] {
	const tools = new Map<string, ToolSpecification>()
	for (const specification of specifications) addTool(tools, specification)
	return [...tools.values()]
}

function addTool(tools: Map<string, ToolSpecification>, specification: ToolSpecification): void {
	const known = tools.get(specification.name)
	if (known !== undefined && known !== specification)
		throw new Error(`Two different tools are named ${specification.name} in one loop or its agent's system prompt: rename one.`)
	tools.set(specification.name, specification)
}
