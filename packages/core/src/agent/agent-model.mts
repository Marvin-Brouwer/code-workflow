/**
 * A model id, such as `claude-opus-5-5`, or several in the order they're tried, such as
 * `['claude-opus-5-5', 'gpt-5.5']`. The run gets the first one a provider with a key offers.
 */
export type AgentModel = string | readonly [string, ...string[]]

/** An agent's model ids, in the order they're tried. */
export function modelIdsOf(model: AgentModel): readonly string[] {
	return typeof model === 'string' ? [model] : model
}
