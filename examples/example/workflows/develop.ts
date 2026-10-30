/**
 * The `example` development workflow: plain async TypeScript, agents as calls.
 *
 * Every `await` is real. While the run waits for a human or an external event, the sandbox is
 * snapshotted and stopped; the answer restores it and the await resolves in the same stack.
 *
 * Design sketch: the packages don't exist yet and this hasn't been type-checked.
 */
import { fail, input, inDependencyOrder, propose, succeed, verify, workflow } from '@engine/core';
import { jira } from '@engine/connector-atlassian';
import { gitlab } from '@engine/connector-gitlab';
import { dotnet } from '@engine/toolchain-dotnet';
import { Plan, Research, codeReview, deliveryOrder, deviations } from '@engine/preset-development';
import { developer, planner, reviewer } from '../agents';

export default workflow('develop', async () => {
    const { key } = await input('Which story should be developed?', { key: jira.key });
    const story = await jira.collect(key);
    await jira.transition(story, 'In Progress');

    const research = await planner.loop`
        Do preliminary research for ${story}.
        Find related issues with ${jira.search} and read them with ${jira.dump}.
        Find the repositories each part of the work touches with ${gitlab.searchRepositories}.
        Write your findings as Markdown in ${Research}, then ${succeed(Research)}.
    `;

    const plan = await planner.loop`
        Create a development plan for ${story}, based on ${research}.
        List every repository that needs changes. When a repository needs something from another one
        first (a new package version, an API contract, a migration), add it to the dependency graph
        with the reason; repositories are delivered in that order.
        Write the plan to plan.md, then propose it with ${propose(Plan)}.
        When the proposal is rejected, revise the plan with the feedback and propose it again.
        If the story can't be planned with the information available, ${fail}.
    `;

    // Starts each repository as soon as the repositories it depends on have returned.
    // Independent repositories run concurrently; a pending review never blocks unrelated work.
    await inDependencyOrder(deliveryOrder(plan), async (part, upstream): Promise<{ packages: string[] }> => {
        const repository = await gitlab.checkout(part.repository, { branch: `feature/${story.key}` });
        await dotnet.updatePackages(repository, upstream.flatMap((dependency) => dependency.packages));

        await developer.loop`
            Implement your part of ${plan.path}, amended by ${deviations}, in ${repository}.
            Build with ${dotnet.build} and test with ${dotnet.test} until both pass,
            then hand in your work with ${verify(
                dotnet.tests(repository),
                dotnet.security(repository),
                codeReview(reviewer, repository, plan),
            )}.
            When it's rejected, fix the findings and hand it in again.
            Record any deviation from the plan with ${deviations.record}.
        `;

        const mergeRequest = await gitlab.openMergeRequest(repository, {
            title: `${story.key}: ${story.summary}`,
            description: await planner.loop`
                Write a short merge request description for the changes in ${repository},
                based on ${plan.path}. ${succeed(gitlab.Description)}
            `,
        });
        await jira.transition(story, 'In Review'); // no-op after the first merge request
        await jira.comment(story, `Merge request for ${repository.name}: ${mergeRequest.url}`);

        // Returns once merged. Handles pipeline failures and tagged comments as they come in.
        await gitlab.review(mergeRequest, {
            pipelineFailed: (failure) => developer.loop`
                The pipeline for ${mergeRequest.url} failed: ${failure.log}.
                Fix it in ${repository} and push with ${gitlab.push(repository)},
                then hand in with ${verify(gitlab.pipelinePasses(mergeRequest))}.
            `,

            taggedComments: (comments) => reviewer.loop`
                Handle these review comments on ${mergeRequest.url}: ${comments}.
                Triage every comment first:
                - a question: answer it, based on the code, ${plan.path} and ${deviations};
                - a remark: decide whether it needs a code change, and reply with what you did or why not.
                A comment can be both.
                Ask ${developer.as('changeCode', { in: repository, verify: [dotnet.tests(repository)] })}
                for code changes and reply with ${gitlab.reply(mergeRequest)}.
                When a remark changes the approach beyond this merge request, record it with
                ${deviations.record}.
                When every comment is handled, ${succeed(gitlab.Triage)}.
            `,
        });

        return { packages: await gitlab.publishedPackages(mergeRequest, 'nuget') };
    });

    await jira.transition(story, 'Done');
});
