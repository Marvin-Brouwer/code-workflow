import { z } from 'zod'
import type { Answer } from '../_shared/api.mts'
import { formText } from './form-text.mts'

/** One field of a form made from a JSON Schema: what to ask for, under its property name. */
export type SchemaField = {
	/** The property's name. A nested field's form name is its object's, then this: see {@link formNameOf}. */
	readonly name: string
	/** The schema's `title`, or else the property name. */
	readonly label: string
	readonly description: string | undefined
	readonly required: boolean
} & (
	| { readonly kind: 'text' | 'number' | 'integer' | 'boolean' }
	| { readonly kind: 'choice' | 'choices'; readonly options: readonly string[] }
	/** A value the schema fixes, such as a pinned repository: shown, not asked for. */
	| { readonly kind: 'fixed'; readonly value: FixedValue }
	/** An object of its own, asked for as a group of fields. */
	| { readonly kind: 'object'; readonly fields: readonly SchemaField[] }
)

/** What goes between an object's form name and its field's name in a nested field's form name. */
const nestedNameSeparator = '.'

/**
 * The name `field` has in the form: its own name, or for a field of an object, the object's form
 * name, {@link nestedNameSeparator}, then its own.
 */
export function formNameOf(field: SchemaField, objectFormName?: string): string {
	if (objectFormName === undefined) return field.name
	return `${objectFormName}${nestedNameSeparator}${field.name}`
}

const FixedValue = z.union([z.string(), z.number(), z.boolean()])
type FixedValue = z.infer<typeof FixedValue>

const describedProperty = { title: z.string().optional(), description: z.string().optional() }
const EnumOptions = z.array(z.string()).min(1)

/**
 * The property schemas a form has a field of its own for: what `input.text/yesNo/choice/choices`
 * make, numbers, and a fixed value.
 */
const FlatProperty = z.union([
	z.object({ const: FixedValue, ...describedProperty }).transform((property) => ({ ...property, kind: 'fixed' as const })),
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
 * The fields of a form for `schema`, when it's an object whose properties are text, numbers, yes
 * or no, one of a few options, several of them, a fixed value, or objects of those in turn.
 * `undefined` for any other schema, and for a property name with {@link nestedNameSeparator} in it,
 * whose form name could be a nested field's: that one gets a JSON text area instead.
 */
export function fieldsOf(schema: unknown): SchemaField[] | undefined {
	const object = ObjectSchema.safeParse(schema)
	if (!object.success) return undefined
	const fields: SchemaField[] = []
	for (const [name, propertySchema] of Object.entries(object.data.properties)) {
		if (name.includes(nestedNameSeparator)) return undefined
		const field = fieldOf(name, propertySchema, object.data.required.includes(name))
		if (field === undefined) return undefined
		fields.push(field)
	}
	return fields
}

/** The field for property `name`, or `undefined` when the form has none for its schema. */
function fieldOf(name: string, propertySchema: unknown, required: boolean): SchemaField | undefined {
	const described = z.object(describedProperty).safeParse(propertySchema)
	const { title, description } = described.success ? described.data : {}
	const shown = { name, label: title ?? name, description, required }
	if (ObjectSchema.safeParse(propertySchema).success) {
		const fields = fieldsOf(propertySchema)
		return fields === undefined ? undefined : { ...shown, kind: 'object', fields }
	}
	const property = FlatProperty.safeParse(propertySchema)
	if (!property.success) return undefined
	const { data } = property
	if (data.kind === 'fixed') return { ...shown, kind: data.kind, value: data.const }
	if (data.kind === 'choice' || data.kind === 'choices') return { ...shown, kind: data.kind, options: data.enum }
	return { ...shown, kind: data.kind }
}

/**
 * The value a form with `fields` holds, the fields of object `objectFormName` when it's given. An
 * empty field that isn't required is left out; a number that isn't one stays text, so the schema
 * says what's wrong with it.
 */
export function valueOf(fields: readonly SchemaField[], form: FormData, objectFormName?: string): Record<string, unknown> {
	return Object.fromEntries(
		fields.flatMap((field) => {
			const value = fieldValue(field, form, formNameOf(field, objectFormName))
			return value === undefined ? [] : [[field.name, value]]
		}),
	)
}

/**
 * Whether anything is filled in among `fields` of object `objectFormName`: text, an option, a ticked
 * box. A fixed value isn't, since the person didn't give it.
 */
function filledIn(fields: readonly SchemaField[], form: FormData, objectFormName: string): boolean {
	return fields.some((field) => {
		const formName = formNameOf(field, objectFormName)
		if (field.kind === 'fixed') return false
		if (field.kind === 'object') return filledIn(field.fields, form, formName)
		return form.getAll(formName).some((value) => value !== '')
	})
}

/**
 * What one field holds, under `formName` in the form, or `undefined` when it's empty and may be left
 * out. An object that isn't required is left out unless something in it is filled in: then it's
 * read whole, and the schema says what it still lacks.
 */
function fieldValue(field: SchemaField, form: FormData, formName: string): unknown {
	if (field.kind === 'fixed') return field.value
	if (field.kind === 'object') {
		if (!field.required && !filledIn(field.fields, form, formName)) return undefined
		return valueOf(field.fields, form, formName)
	}
	if (field.kind === 'boolean') return form.has(formName)
	if (field.kind === 'choices') return form.getAll(formName).map(String)
	const text = formText(form, formName)
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
