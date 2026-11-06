/**
 * Type tests for `loop`'s result. Checked by `tsc`; nothing here runs.
 *
 * Every call site is written the way a workflow author would write it: no annotation, no generic
 * argument, no `as const`.
 */
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import {
    type Agent,
    type Check,
    type WorkspaceFolder,
    fail,
    propose,
    succeed,
    tool,
    verify,
    workspace,
} from '../src/core.js';

declare const agent: Agent;
declare const tests: Check;
declare const review: Check;
declare function anyValue(): any; // oxlint-disable-line typescript/no-explicit-any

const Plan = z.object({ path: z.string(), repositories: z.array(z.string()) });
type Plan = z.infer<typeof Plan>;
const Description = z.object({ description: z.string() });
type Description = z.infer<typeof Description>;
const Research = workspace.folder('research', { minFiles: 1 });
const search = tool('search', { input: z.object({ query: z.string() }), action: () => Promise.resolve([]) });
const notes = workspace.file('notes.md');

export async function cases() {
    // No exits: the agent's final text.
    expectTypeOf(await agent.loop`Summarize ${notes}.`).toEqualTypeOf<string>();
    expectTypeOf(await agent.loop`Say hello.`).toEqualTypeOf<string>();

    // A single exit.
    expectTypeOf(await agent.loop`Done? ${succeed()}`).toEqualTypeOf<void>();
    expectTypeOf(await agent.loop`Plan, then ${succeed(Plan)}.`).toEqualTypeOf<Plan>();
    expectTypeOf(await agent.loop`Write ${Research}, then ${succeed(Research)}.`).toEqualTypeOf<WorkspaceFolder>();
    expectTypeOf(await agent.loop`Plan, then ${propose(Plan)}.`).toEqualTypeOf<Plan>();
    expectTypeOf(await agent.loop`Implement, then ${verify(tests, review)}.`).toEqualTypeOf<void>();
    expectTypeOf(await agent.loop`Implement, then ${verify({ maxRejections: 3 }, tests)}.`).toEqualTypeOf<void>();

    // Gates add nothing next to a result-bearing exit.
    expectTypeOf(await agent.loop`${verify(tests)} before ${propose(Plan)}.`).toEqualTypeOf<Plan>();
    expectTypeOf(await agent.loop`${verify(tests)} before ${succeed(Plan)}.`).toEqualTypeOf<Plan>();
    expectTypeOf(await agent.loop`${verify(tests)} or ${succeed()}.`).toEqualTypeOf<void>();

    // `fail` adds nothing; on its own the loop can only reject.
    expectTypeOf(await agent.loop`${propose(Plan)}, or ${fail}.`).toEqualTypeOf<Plan>();
    expectTypeOf(await agent.loop`Give up: ${fail}.`).toEqualTypeOf<never>();

    // Two result-bearing exits give a union.
    expectTypeOf(await agent.loop`${succeed(Plan)} or ${succeed(Description)}.`).toEqualTypeOf<Plan | Description>();

    // Non-exit values (tools, files, folders, strings, numbers, objects) don't change the result.
    expectTypeOf(
        await agent.loop`Use ${search} on ${notes} and ${Research} for ${'story'} ${42} ${{ key: 'X-1' }}, then ${propose(Plan)}.`,
    ).toEqualTypeOf<Plan>();
    expectTypeOf(await agent.loop`Use ${search} on ${notes} for ${{ key: 'X-1' }}.`).toEqualTypeOf<string>();

    // An `any` value is skipped, it doesn't turn the result into `any`.
    expectTypeOf(await agent.loop`Read ${anyValue()}, then ${propose(Plan)}.`).toEqualTypeOf<Plan>();
    expectTypeOf(await agent.loop`Read ${anyValue()}.`).toEqualTypeOf<string>();

    // A value typed `unknown` is not an exit either.
    const opaque: unknown = JSON.parse('{}');
    expectTypeOf(await agent.loop`Read ${opaque}.`).toEqualTypeOf<string>();

    // Exits held in variables or built in helpers are still found.
    const handIn = verify(tests);
    const approve = propose(Plan);
    expectTypeOf(await agent.loop`${handIn}, then ${approve}.`).toEqualTypeOf<Plan>();
}

export async function negativeCases() {
    // A Plan result can't be used as text.
    // @ts-expect-error: Plan is not a string
    const text: string = await agent.loop`Plan, then ${propose(Plan)}.`;

    // A loop without exits can't be used as a Plan.
    // @ts-expect-error: string is not a Plan
    const plan: Plan = await agent.loop`Say hello.`;

    // A look-alike object is rendered as text, not taken as an exit.
    const lookAlike = { kind: 'exit', result: 42 } as const;
    const result = await agent.loop`Not an exit: ${lookAlike}.`;
    expectTypeOf(result).toEqualTypeOf<string>();
    // @ts-expect-error: the result is text, not 42
    const answer: 42 = result;

    // `succeed` only takes a schema or a workspace folder.
    // @ts-expect-error: a workspace file is not an exit schema
    succeed(notes);

    return [text, plan, answer];
}
