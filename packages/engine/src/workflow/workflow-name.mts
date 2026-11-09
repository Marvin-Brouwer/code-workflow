import { z } from 'zod'

/** Lowercase letters, digits and dashes, starting with a letter or digit: names that go into URLs, run keys and file names. */
export const kebabNamePattern = /^[a-z0-9][a-z0-9-]*$/

/** A workflow's name, as `workflow()` in `@mesh-flow/core` takes it. */
export const WorkflowName = z.string().regex(kebabNamePattern, 'A workflow name is lowercase letters, digits and dashes.')

/** A webhook's name, as `webhook()` in `@mesh-flow/core` gives it: its own name, or its workflow's. */
export const WebhookName = z.string().regex(kebabNamePattern, 'A webhook name is lowercase letters, digits and dashes.')
