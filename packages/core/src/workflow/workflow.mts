import { z } from 'zod'
import { registerWorkflow } from './workflow-registry.mts'

/** The parameters of a workflow without any. */
export type NoParameters = Record<string, never>

/** What a workflow's body gets: its parameters, checked, and the run's signal. */
export interface WorkflowContext<Parameters> {
	readonly parameters: Parameters
	/** Aborted when the run is stopped. Pass it on to everything the body waits for outside mesh-flow. */
	readonly abortSignal: AbortSignal
}

/** A workflow: a name, what a run of it starts with, and a body of plain async code. */
export interface Workflow<Shape extends z.ZodRawShape = NoParameters> {
	/** Identifies the workflow's runs. */
	readonly name: string
	/** What a run starts with. Triggers have to give the input side of it. */
	readonly parameters: z.ZodObject<Shape>
	// A method, so a workflow with parameters is still a `Workflow` to code that takes any workflow.
	body(context: WorkflowContext<z.output<z.ZodObject<Shape>>>): Promise<void>
}

/** Any workflow, whatever its parameters. */
export type AnyWorkflow = Workflow<z.ZodRawShape>

/** The input side of a workflow's parameters: what a trigger, a form or the CLI gives it. */
export type ParametersOf<Definition> = Definition extends Workflow<infer Shape> ? z.input<z.ZodObject<Shape>> : never

/** Workflow names: they go into run ids, loop keys, file names and URLs. */
export const WorkflowName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes.')

/**
 * Defines a workflow. The body is ordinary async code: `await`, `if`, `for`, `Promise.all` and
 * `throw` are the control flow, and agents are calls inside it. A workflow says what it does and
 * what it starts with, never how it is started: that is the entry file's job (`defineWorkflows`).
 *
 * ```ts
 * export const develop = workflow('develop', { key: jira.key }, async ({ parameters }) => {
 * 	const story = await jira.collect(parameters.key)
 * 	const plan = await planner.loop`Plan ${story}, then propose it with ${propose(Plan)}.`
 * 	// ...
 * })
 * ```
 *
 * The parameters are a zod shape, like `input`'s fields. A run's parameters are checked against it
 * before the body starts. Without parameters, leave them out: `workflow('report', async () => ...)`.
 */
export function workflow(name: string, body: (context: WorkflowContext<NoParameters>) => Promise<void>): Workflow
export function workflow<Shape extends z.ZodRawShape>(
	name: string,
	parameters: Shape,
	body: (context: WorkflowContext<z.output<z.ZodObject<Shape>>>) => Promise<void>,
): Workflow<Shape>
export function workflow(
	name: string,
	parametersOrBody: z.ZodRawShape | ((context: WorkflowContext<NoParameters>) => Promise<void>),
	body?: (context: WorkflowContext<Record<string, unknown>>) => Promise<void>,
): AnyWorkflow {
	if (!WorkflowName.safeParse(name).success) throw new Error(`Workflow name ${name}: use lowercase letters, digits and dashes.`)
	const [shape, run] = typeof parametersOrBody === 'function' ? [{}, parametersOrBody] : [parametersOrBody, body]
	if (run === undefined) throw new Error(`Workflow ${name} has no body.`)
	const definition: AnyWorkflow = Object.freeze({ name, parameters: z.object(shape), body: run })
	registerWorkflow(definition)
	return definition
}
