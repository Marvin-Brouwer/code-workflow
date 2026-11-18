import { z } from 'zod'
import { describe, expect, test } from 'vitest'
import { checkAgainst, fieldsOf, jsonOf, valueOf } from '../../app/src/_forms/schema-fields.mts'

/** A JSON Schema as the engine sends it: a workflow's parameters, or an input request's fields. */
function jsonSchema(schema: z.ZodType): unknown {
	return z.toJSONSchema(schema, { io: 'input' })
}

/** Form data with `entries`, as a browser sends a form. */
function formData(entries: readonly (readonly [string, string])[]): FormData {
	const form = new FormData()
	for (const [name, value] of entries) form.append(name, value)
	return form
}

const parameters = jsonSchema(
	z.object({
		story: z.string().describe('The story to work on'),
		draft: z.boolean(),
		size: z.enum(['small', 'large']),
		labels: z.array(z.enum(['bug', 'chore'])),
		retries: z.number().int().optional(),
		note: z.string().optional(),
	}),
)

describe('fieldsOf', () => {
	test('gives a field per property of a flat object, with what it asks for', () => {
		// Act
		const fields = fieldsOf(parameters)

		// Assert
		expect(fields).toEqual([
			{ name: 'story', label: 'story', description: 'The story to work on', required: true, kind: 'text' },
			{ name: 'draft', label: 'draft', description: undefined, required: true, kind: 'boolean' },
			{ name: 'size', label: 'size', description: undefined, required: true, kind: 'choice', options: ['small', 'large'] },
			{ name: 'labels', label: 'labels', description: undefined, required: true, kind: 'choices', options: ['bug', 'chore'] },
			{ name: 'retries', label: 'retries', description: undefined, required: false, kind: 'integer' },
			{ name: 'note', label: 'note', description: undefined, required: false, kind: 'text' },
		])
	})

	test.each([
		['a nested object', z.object({ repository: z.object({ owner: z.string() }) })],
		['an array of text', z.object({ paths: z.array(z.string()) })],
		['a union', z.object({ target: z.union([z.string(), z.number()]) })],
		['no object at all', z.string()],
	])('leaves %s to a JSON text area', (_name, schema) => {
		// Act
		const fields = fieldsOf(jsonSchema(schema))

		// Assert
		expect(fields).toBeUndefined()
	})
})

describe('valueOf', () => {
	test('reads each field as its kind, and leaves out empty fields that are not required', () => {
		// Arrange
		const fields = fieldsOf(parameters) ?? []
		const form = formData([
			['story', 'ABC-1'],
			['draft', 'on'],
			['size', 'large'],
			['labels', 'bug'],
			['labels', 'chore'],
			['retries', ''],
			['note', ''],
		])

		// Act
		const value = valueOf(fields, form)

		// Assert
		expect(value).toEqual({ story: 'ABC-1', draft: true, size: 'large', labels: ['bug', 'chore'] })
		expect(checkAgainst(parameters, value)).toEqual({ ok: true, value })
	})

	test('gives an unchecked box as false, no options as none, and a number as a number', () => {
		// Arrange
		const fields = fieldsOf(parameters) ?? []
		const form = formData([
			['story', ''],
			['size', 'small'],
			['retries', '3'],
		])

		// Act
		const value = valueOf(fields, form)

		// Assert
		expect(value).toEqual({ story: '', draft: false, size: 'small', labels: [], retries: 3 })
	})
})

describe('checkAgainst', () => {
	test('says what does not fit the schema', () => {
		// Act
		const checked = checkAgainst(parameters, { story: 'ABC-1', draft: true, size: 'medium', labels: [], retries: 'three' })

		// Assert
		expect(checked).toEqual({ ok: false, error: expect.stringMatching(/size[\s\S]*retries/) as unknown })
	})

	test('leaves a schema it cannot read to the server', () => {
		// Act
		const checked = checkAgainst({ type: 'no such type' }, 1)

		// Assert
		expect(checked).toEqual({ ok: true, value: 1 })
	})
})

describe('jsonOf', () => {
	test('reads JSON, and says so when it is not', () => {
		// Act
		const read = jsonOf('{"owner":"me"}')
		const notRead = jsonOf('{owner')

		// Assert
		expect(read).toEqual({ ok: true, value: { owner: 'me' } })
		expect(notRead).toEqual({ ok: false, error: expect.stringContaining("That isn't JSON") as unknown })
	})
})
