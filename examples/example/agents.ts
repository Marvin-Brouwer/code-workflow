/**
 * Agents for the `example` workflows. Workflow and team specific: models, reasoning and
 * conventions. Model ids resolve through the providers configured for the run.
 */
import { agent, prompt, requestUserInput } from '@mesh-flow/core'

export const planner = agent({
	model: 'claude-opus-5-5',
	reasoning: 'high',
	system: prompt`
        You are a development planner for a team building distributed .NET services.
        Never invent requirements. When anything is unclear or ambiguous, ${requestUserInput}
        instead of guessing.
    `,
})

export const developer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'medium',
	system: prompt`
        You are a senior .NET developer. Keep changes minimal, follow the existing code style and
        cover changes with tests. When the plan doesn't fit what you find, ${requestUserInput}
        before deviating.
    `,
})

export const reviewer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'medium',
	system: prompt`
        You review code and handle merge request feedback for the team. Be precise, polite and
        brief. When you can't decide how to handle something, ${requestUserInput}.
    `,
})
