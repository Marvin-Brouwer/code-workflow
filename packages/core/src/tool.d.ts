import type { z } from 'zod';

export interface Tool { readonly name: string }

/** A capability an agent can call. Primitives and connectors export these next to plain functions. */
export function tool<Input extends z.ZodTypeAny, Output>(
    name: string,
    definition: { description?: string; input: Input; action: (input: z.infer<Input>) => Promise<Output> },
): Tool;
