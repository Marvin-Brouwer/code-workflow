/**
 * Agents for the `example` workflows. Workflow and team specific: models, reasoning and
 * conventions. Model ids resolve through the providers configured for the app.
 */
import { agent, prompt, requestUserInput } from '@mesh-flow/core'

/** Researches the story and writes the plan. */
export const planner = agent({
	model: 'claude-opus-5-5',
	reasoning: 'high',
	system: prompt`
		You are a development planner for a team building distributed .NET services.
		Never invent requirements. When anything is unclear or ambiguous, ${requestUserInput}
		instead of guessing.
	`,
})

/** Implements the plan in each repository, and answers the review. */
export const developer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'medium',
	system: prompt`
		You are a senior .NET developer. Keep changes minimal, follow the existing code style and
		cover changes with tests. When the plan doesn't fit what you find, ${requestUserInput}
		before deviating.
	`,
})

/** Reviews each repository's change against the plan. */
export const reviewer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'medium',
	system: prompt`
		You review code and handle merge request feedback for the team. Be precise, polite and
		brief. When you can't decide how to handle something, ${requestUserInput}.
	`,
})

/** Writes merge request titles and descriptions, from the commits, the diff and the project's templates. */
export const writer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'low',
	system: prompt`
		You write merge request titles and descriptions for the team: what changed and why, for a
		reviewer who hasn't seen the work. Follow the project's templates and conventions.
	`,
})
