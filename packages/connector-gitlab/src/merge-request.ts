import { git, type Repository } from '@mesh-flow/git'
import { z } from 'zod'
import { api, type MergeRequest } from './api'

export const Description = z.object({ description: z.string() })

export async function openMergeRequest(
	repository: Repository,
	options: { title: string; description: z.infer<typeof Description> },
): Promise<MergeRequest> {
	await git.commitAll(repository, options.title)
	await git.push(repository)
	return api.openMergeRequest({ repository, title: options.title, description: options.description.description })
}

export function publishedPackages(mergeRequest: MergeRequest, kind: 'nuget' | 'npm'): Promise<string[]> {
	return api.publishedPackages(mergeRequest, kind)
}
