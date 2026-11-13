import type { ForgeTerms } from '@mesh-flow/forge'

/** How the GitHub connector names what it does, in prompts, tool names and errors. */
export const githubTerms: ForgeTerms = Object.freeze({ forge: 'GitHub', request: 'pull request', toolPrefix: 'github' })
