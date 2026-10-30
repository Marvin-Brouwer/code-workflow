/**
 * .NET toolchain: tools for agents, functions for code, checks for `verify`. No agents.
 */
import { check, tool } from '@engine/core';
import { type Repository } from '@engine/git';
import { z } from 'zod';
import { cli } from './cli';

// ─── Tools: the developer uses these to verify its own work ──────────────────────────────────

export const build = tool('build', {
    description: 'Build the solution in a repository.',
    input: z.object({ repository: z.string() }),
    action: ({ repository }) => cli.build(repository),
});

export const test = tool('test', {
    description: 'Run tests in a repository, optionally filtered.',
    input: z.object({ repository: z.string(), filter: z.string().optional() }),
    action: ({ repository, filter }) => cli.test(repository, filter),
});

// ─── Functions ───────────────────────────────────────────────────────────────────────────────

/** Updates package references to the given versions, e.g. `Company.Contracts@2.4.0`. No-op when empty. */
export function updatePackages(repository: Repository, packages: readonly string[]): Promise<void> {
    return packages.length === 0 ? Promise.resolve() : cli.updatePackages(repository, packages);
}

// ─── Checks: the gate that verifies what the developer claims ────────────────────────────────

export function tests(repository: Repository) {
    return check('tests', async () => {
        const result = await cli.test(repository);
        return result.failures.map((message) => ({ source: 'tests', message }));
    });
}

export function security(repository: Repository) {
    return check('security', async () => {
        const [scan, audit] = await Promise.all([cli.virusScan(repository), cli.auditPackages(repository)]);
        return [
            ...scan.detections.map((message) => ({ source: 'virus scan', message })),
            ...audit.vulnerable.map((message) => ({ source: 'dependency audit', message })),
        ];
    });
}
