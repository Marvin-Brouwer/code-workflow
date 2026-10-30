import type { Repository } from '@engine/git';

export interface MergeRequest { readonly url: string }

export type ReviewEvent =
    | { readonly type: 'pipelineFailed'; readonly log: string }
    | { readonly type: 'comment'; readonly id: string; readonly body: string };

export declare const api: {
    openMergeRequest(request: { repository: Repository; title: string; description: string }): Promise<MergeRequest>;
    watch(
        mergeRequest: MergeRequest,
        options: {
            until: 'merged';
            pipelineFailed?: (failure: Extract<ReviewEvent, { type: 'pipelineFailed' }>) => Promise<unknown>;
            taggedComments?: (comments: Extract<ReviewEvent, { type: 'comment' }>[]) => Promise<unknown>;
        },
    ): Promise<void>;
    publishedPackages(mergeRequest: MergeRequest, kind: 'nuget' | 'npm'): Promise<string[]>;
    searchProjects(query: string): Promise<readonly { name: string }[]>;
    reply(mergeRequest: MergeRequest, commentId: string, text: string): Promise<void>;
    waitForPipeline(mergeRequest: MergeRequest): Promise<{ failedJobs: readonly { name: string; log: string }[] }>;
};
