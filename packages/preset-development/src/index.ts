/**
 * Development preset: schemas, the code review check and plan deviations. Ships no agents.
 */
import { type Agent, check, succeed, tool, workspace } from '@engine/core';
import { z } from 'zod';

/**
 * Research is a folder of Markdown files, not data. `succeed(Research)` only accepts it once the
 * folder contains at least one Markdown file, and the result renders in later prompts as the
 * folder with its files.
 */
export const Research = workspace.folder('research', {
    description: 'Research notes: related issues, affected repositories, open questions',
    minFiles: 1,
});

export const Plan = z.object({
    path: z.string().describe('Path of plan.md'),
    repositories: z.array(z.object({
        name: z.string().describe('Project path on the source host, e.g. group/project'),
        changes: z.string().describe('Summary of the changes in this repository'),
    })),
    dependencies: z.array(z.object({
        repository: z.string(),
        dependsOn: z.string().describe('Repository that must be merged and published first'),
        reason: z.string().describe('What it needs from it, e.g. a new package version or API contract'),
    })).describe('Dependency graph between the repositories; empty when they are independent'),
});
export type Plan = z.infer<typeof Plan>;

const Findings = z.object({ findings: z.array(z.object({ source: z.string(), message: z.string() })) });

/** One node per repository, for `inDependencyOrder`. */
export function deliveryOrder(plan: Plan) {
    return plan.repositories.map((repository) => ({
        id: repository.name,
        repository: repository.name,
        dependsOn: plan.dependencies
            .filter((dependency) => dependency.repository === repository.name)
            .map((dependency) => dependency.dependsOn),
    }));
}

/** A check that has an agent review the changes against the plan. */
export function codeReview(reviewer: Agent, repository: { name: string }, plan: Plan) {
    return check('code review', async () => {
        const { findings } = await reviewer.loop`
            Review the changes in ${repository} against ${plan.path} and ${deviations}.
            Report only real problems: bugs, missing tests, deviations from the plan that weren't
            recorded. When you're done, ${succeed(Findings)}.
        `;
        return findings.map((finding) => ({ ...finding, source: `code review: ${finding.source}` }));
    });
}

/**
 * Plan deviations: the approved plan.md stays as approved; later findings are recorded next to it.
 * Interpolated in a prompt, it renders as the file; `deviations.record` is the tool to add one.
 */
export const deviations = Object.assign(workspace.file('plan-deviations.md'), {
    record: tool('recordDeviation', {
        input: z.object({
            repository: z.string(),
            reason: z.string().describe('What was found, and where (review comment, pipeline, implementation)'),
            change: z.string().describe('How the work now deviates from plan.md'),
        }),
        action: (deviation) => workspace.file('plan-deviations.md').append(deviation),
    }),
});
