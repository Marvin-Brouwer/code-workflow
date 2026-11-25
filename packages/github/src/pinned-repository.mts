import { z } from 'zod'

/**
 * The repository `issueSchema` is fixed to, when it's made by `github.issueIn`: what a webhook for
 * the workflow fits.
 */
export function pinnedRepository(issueSchema: unknown): string | undefined {
	if (!(issueSchema instanceof z.ZodObject)) return undefined
	const repository: unknown = issueSchema.shape['repository']
	if (!(repository instanceof z.ZodLiteral)) return undefined
	const [value]: unknown[] = [...repository.values]
	return typeof value === 'string' ? value : undefined
}
