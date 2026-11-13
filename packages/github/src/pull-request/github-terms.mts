import type { CodeHostTerms } from '@mesh-flow/code-repository'

/** How the GitHub connector names what it does, in prompts, tool names and errors. */
export const githubTerms: CodeHostTerms = Object.freeze({ codeHost: 'GitHub', request: 'pull request', toolPrefix: 'github' })
