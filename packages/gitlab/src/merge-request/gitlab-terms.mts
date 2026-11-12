import type { ForgeTerms } from '@mesh-flow/forge'

/** How the GitLab connector names what it does, in prompts, tool names and errors. */
export const gitlabTerms: ForgeTerms = Object.freeze({ forge: 'GitLab', request: 'merge request', toolPrefix: 'gitlab' })
