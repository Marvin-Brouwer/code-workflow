import { z } from 'zod'
import type { Answer } from '../_shared/api.mts'
import { formText } from './form-text.mts'

/** One field of a form made from a JSON Schema: what to ask for, under its property name. */
export type SchemaField = {
	readonly name: string
	/** The schema's `title`, or else the property name. */
	readonly label: string
	readonly description: string | undefined
	readonly required: boolean
} & (
	| { readonly kind: 'text' | 'number' | 'integer' | 'boolean' }
	| { readonly kind: 'choice' | 'choices'; readonly options: readonly string[] }
)

const describedProperty = { title: z.string().optional(), description: z.string().optional() }
const EnumOptions = z.array(z.string()).min(1)

/** The property schemas a form has a field for: what `input.text/yesNo/choice/choices` make, and numbers. */
const FlatProperty = z.union([
	z
		.object({ type: z.literal('string'), enum: EnumOptions, ...describedProperty })
		.transform((property) => ({ ...property, kind: 'choice' as const })),
	z
		.object({ type: z.literal('array'), items: z.object({ type: z.literal('string'), enum: EnumOptions }), ...describedProperty })
		.transform((property) => ({ ...property, kind: 'choices' as const, enum: property.items.enum })),
	z
		.object({ type: z.enum(['string', 'number', 'integer', 'boolean']), enum: z.undefined().optional(), ...describedProperty })
		.transform((property) => ({ ...property, kind: property.type === 'string' ? ('text' as const) : property.type })),
])

const ObjectSchema = z.object({
	type: z.literal('object'),
	properties: z.record(z.string(), z.unknown()),
	required: z.array(z.string()).default([]),
})

/**
 * The fields of a form for `schema`, when it's a flat object whose properties are text, numbers,
 * yes or no, one of a few options or several of them. `undefined` for any other schema: that one
 * gets a JSON text area instead.
 */
export function fieldsOf(schema: unknown): SchemaField[] | undefined {
	const object = ObjectSchema.safeParse(schema)
	if (!object.success) return undefined
	const fields: SchemaField[] = []
	for (const [name, propertySchema] of Object.entries(object.data.properties)) {
		const property = FlatProperty.safeParse(propertySchema)
		if (!property.success) return undefined
		const { kind, title, description } = property.data
		const shown = { name, label: title ?? name, description, required: object.data.required.includes(name) }
		fields.push(kind === 'choice' || kind === 'choices' ? { ...shown, kind, options: property.data.enum } : { ...shown, kind })
	}
	return fields
}

/**
 * The value a form with `fields` holds. An empty field that isn't required is left out; a number
 * that isn't one stays text, so the schema says what's wrong with it.
 */
export function valueOf(fields: readonly SchemaField[], form: FormData): Record<string, unknown> {
	return Object.fromEntries(
		fields.flatMap((field) => {
			const value = fieldValue(field, form)
			return value === undefined ? [] : [[field.name, value]]
		}),
	)
}

/** What one field holds, or `undefined` when it's empty and may be left out. */
function fieldValue(field: SchemaField, form: FormData): unknown {
	if (field.kind === 'boolean') return form.has(field.name)
	if (field.kind === 'choices') return form.getAll(field.name).map(String)
	const text = formText(form, field.name)
	if (text === '') return field.required ? text : undefined
	if (field.kind === 'text' || field.kind === 'choice') return text
	const number = Number(text)
	return Number.isNaN(number) ? text : number
}

/** The value of a JSON text area, or why it isn't JSON. */
export function jsonOf(text: string): Answer<unknown> {
	try {
		return { ok: true, value: JSON.parse(text) }
	} catch (error) {
		return { ok: false, error: `That isn't JSON: ${error instanceof Error ? error.message : String(error)}` }
	}
}

/**
 * Checks `value` against `schema`, the same JSON Schema the server checks it with, so the form can
 * say what's wrong before it sends. A schema zod can't read passes here: the server still checks.
 */
export function checkAgainst(schema: unknown, value: unknown): Answer<unknown> {
	const checker = checkerOf(schema)
	if (checker === undefined) return { ok: true, value }
	const checked = checker.safeParse(value)
	return checked.success ? { ok: true, value } : { ok: false, error: z.prettifyError(checked.error) }
}

/** A zod schema that checks what `schema` does, or `undefined` when zod can't read it. */
function checkerOf(schema: unknown): z.ZodType | undefined {
	try {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a schema zod can't read throws, and is left to the server
		return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
	} catch {
		return undefined
	}
}
