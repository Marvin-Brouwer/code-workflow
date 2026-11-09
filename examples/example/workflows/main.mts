/**
 * The entry file: everything that can start a run of the `example` workflows. A workflow says what
 * it does and what it starts with; this file says how it gets started.
 *
 * Once the atlassian connector ships its event schemas, a Jira webhook (a story labelled for
 * development) goes here as `webhook(develop, ...)`, next to the button.
 */
import { defineWorkflows, userTrigger } from '@mesh-flow/core'
import { develop } from './develop.mts'

// A button in the UI, with the story's key as its form.
export default defineWorkflows(userTrigger(develop))
