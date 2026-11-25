import { z } from 'zod'

/**
 * The repository `issueSchema` is pinned to, when `github.issueIn` made it, so a webhook can skip
 * other repositories' events. `undefined` for any other schema, such as `github.issue`.
 */
export function pinnedRepository(issueSchema: unknown): string | undefined {
	if (!(issueSchema instanceof z.ZodObject)) return undefined
	const repository: unknown = issueSchema.shape['repository']
	if (!(repository instanceof z.ZodLiteral)) return undefined
	const [pinned]: unknown[] = [...repository.values]
	return typeof pinned === 'string' ? pinned : undefined
}
