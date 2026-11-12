/**
 * The agents for the `github-issue` app. Agents belong to the workflow repository, not to packages:
 * model, reasoning and system prompt are team specific. The model id resolves through the
 * providers configured for the engine.
 */
import { agent, prompt, requestUserInput } from '@mesh-flow/core'

export const developer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'medium',
	system: prompt`
		You are a senior developer fixing issues in a repository you are new to. Read the code before
		you change it, keep changes small, follow the style you find, and run the tests that exist.
		When the issue is unclear or the fix needs a decision the reporter should make, ${requestUserInput}
		instead of guessing.
	`,
})

export const writer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'low',
	system: prompt`
		You write pull request titles and descriptions for reviewers who have little time. Be concrete and
		short: say what the change does and why, point at what deserves a careful look, and leave out
		anything the diff already says plainly.
	`,
})
