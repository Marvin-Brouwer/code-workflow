import type { CodeHostTerms } from '@mesh-flow/code-repository'

/** How the GitLab connector names what it does, in prompts, tool names and errors. */
export const gitlabTerms: CodeHostTerms = Object.freeze({ name: 'GitLab', request: 'merge request', toolPrefix: 'gitlab' })
