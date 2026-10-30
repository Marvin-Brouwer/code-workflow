/**
 * GitLab connector: plain functions for code, tools for agents, checks for `verify`.
 * Every function is idempotent where it creates something (reuses an existing checkout, branch
 * or merge request), so a rerun after a lost snapshot is cheap.
 */
import { check, tool } from '@engine/core';
import { git, type Repository } from '@engine/git';
import { z } from 'zod';
import { api, type MergeRequest, type ReviewEvent } from './api';

export const Description = z.object({ description: z.string() });

export const Triage = z.object({
    comments: z.array(z.object({
        commentId: z.string(),
        kind: z.enum(['question', 'remark', 'both']),
        action: z.enum(['answered', 'changed', 'declined', 'escalated']),
        summary: z.string(),
    })),
});

// ─── Functions ───────────────────────────────────────────────────────────────────────────────

export function checkout(project: string, options: { branch: string }): Promise<Repository> {
    return git.checkout(project, options);
}

export async function openMergeRequest(
    repository: Repository,
    options: { title: string; description: { description: string } },
): Promise<MergeRequest> {
    await git.commitAll(repository, options.title);
    await git.push(repository);
    return api.openMergeRequest({ repository, title: options.title, description: options.description.description });
}

/**
 * Watches a merge request until it's merged and calls the handlers as events come in.
 * Waits durably on the engine's external-event primitive. Policies: handlers run one at a time
 * per merge request, events for superseded commits are dropped, comments from one review round
 * are coalesced into one call.
 */
export function review(
    mergeRequest: MergeRequest,
    handlers: {
        pipelineFailed?: (failure: Extract<ReviewEvent, { type: 'pipelineFailed' }>) => Promise<unknown>;
        taggedComments?: (comments: Extract<ReviewEvent, { type: 'comment' }>[]) => Promise<unknown>;
    },
): Promise<void> {
    return api.watch(mergeRequest, { until: 'merged', ...handlers });
}

export function publishedPackages(mergeRequest: MergeRequest, kind: 'nuget' | 'npm'): Promise<string[]> {
    return api.publishedPackages(mergeRequest, kind);
}

// ─── Tools ───────────────────────────────────────────────────────────────────────────────────

export const searchRepositories = tool('searchRepositories', {
    description: 'Search projects on GitLab by name or description.',
    input: z.object({ query: z.string() }),
    action: ({ query }) => api.searchProjects(query),
});

export function push(repository: Repository) {
    return tool('push', {
        description: `Commit all changes in ${repository.name} and push them.`,
        input: z.object({ message: z.string() }),
        async action({ message }) {
            await git.commitAll(repository, message);
            await git.push(repository);
            return { pushed: true };
        },
    });
}

export function reply(mergeRequest: MergeRequest) {
    return tool('reply', {
        description: 'Reply to a comment on the merge request.',
        input: z.object({ commentId: z.string(), text: z.string() }),
        action: ({ commentId, text }) => api.reply(mergeRequest, commentId, text),
    });
}

// ─── Checks ──────────────────────────────────────────────────────────────────────────────────

/** Waits for the pipeline of the latest commit; its failed jobs are the findings. */
export function pipelinePasses(mergeRequest: MergeRequest) {
    return check('pipeline', async () => {
        const pipeline = await api.waitForPipeline(mergeRequest);
        return pipeline.failedJobs.map((job) => ({ source: `pipeline: ${job.name}`, message: job.log }));
    });
}
