import { choice, component } from '@rooted/components'
import type { Answer } from '../_shared/api.mts'
import styles from './forms.css'
import { formStatus, submitActions } from './form-parts.mts'
import { formText } from './form-text.mts'
import { checkAgainst, fieldsOf, jsonOf, valueOf, type SchemaField } from './schema-fields.mts'
import { submitForm } from './submit-form.mts'

/** What the schema form asks for, and what it does with the answer. */
export interface SchemaFormOptions {
	/**
	 * The JSON Schema of what the form sends, such as a workflow's parameters. An input request's
	 * fields are a record of schemas, so they go in as the object schema they make together.
	 */
	readonly schema: unknown
	readonly submitLabel: string
	/** Sends the value, once it fits the schema. */
	readonly send: (value: unknown, abortSignal: AbortSignal) => Promise<Answer<unknown>>
	readonly done?: (() => void) | undefined
}

/**
 * A form for a JSON Schema. An object of text, numbers, yes or no, options and fixed values gets a
 * field per property, and a group of fields per object in it; anything else gets a JSON text area. Either way the value is checked against the schema
 * before it's sent, and the server checks it again.
 */
export const SchemaForm = component<SchemaFormOptions>({
	name: 'schema-form',
	styles,
	onMount({ append, element, options, signal }) {
		const { schema, submitLabel, send, done } = options
		const status = formStatus(element)
		const fields = fieldsOf(schema)

		const fieldElement = (field: SchemaField, prefix: string): HTMLElement => {
			const formName = `${prefix}${field.name}`
			const hint =
				field.description === undefined
					? undefined
					: element('span', {
							classes: styles.hint,
							textContent: field.description,
						})
			if (field.kind === 'object')
				return element('fieldset', {
					children: [
						element('legend', {
							textContent: field.label,
						}),
						hint,
						...field.fields.map((nested) => fieldElement(nested, `${formName}.`)),
					],
				})
			// Fixed by the workflow, so it's said, not asked: no field that looks like it could be changed.
			if (field.kind === 'fixed')
				return element('p', {
					classes: styles.fixed,
					children: [
						`${field.label}: `,
						element('code', {
							textContent: String(field.value),
						}),
						hint,
					],
				})
			if (field.kind === 'boolean')
				return element('label', {
					classes: styles.inline,
					children: [
						element('input', {
							name: formName,
							type: 'checkbox',
						}),
						field.label,
						hint,
					],
				})
			if (field.kind === 'choices')
				return element('fieldset', {
					children: [
						element('legend', {
							textContent: field.label,
						}),
						hint,
						...field.options.map((option) =>
							element('label', {
								classes: styles.inline,
								children: [
									element('input', {
										name: formName,
										type: 'checkbox',
										value: option,
									}),
									option,
								],
							}),
						),
					],
				})
			const input =
				field.kind === 'choice'
					? element('select', {
							name: formName,
							required: field.required,
							children: [
								element('option', {
									value: '',
									textContent: '',
								}),
								...field.options.map((option) =>
									element('option', {
										value: option,
										textContent: option,
									}),
								),
							],
						})
					: element('input', {
							name: formName,
							required: field.required,
							type: choice(field.kind === 'text', 'text', 'number'),
							// An empty step is the default one, which an integer wants.
							step: choice(field.kind === 'number', 'any', ''),
						})
			return element('label', {
				children: [field.label, hint, input],
			})
		}

		const formValue = (form: FormData): Answer<unknown> =>
			fields === undefined ? jsonOf(formText(form, 'json')) : { ok: true, value: valueOf(fields, form) }

		append(
			element('form', {
				classes: styles.form,
				children: [
					...(fields === undefined
						? [
								element('label', {
									children: [
										'As JSON',
										element('textarea', {
											name: 'json',
											rows: 8,
											value: '{}',
										}),
									],
								}),
								element('details', {
									children: [
										element('summary', {
											textContent: 'Schema',
										}),
										element('pre', {
											textContent: JSON.stringify(schema, undefined, 2),
										}),
									],
								}),
							]
						: fields.map((field) => fieldElement(field, ''))),
					submitActions(element, submitLabel),
					status,
				],
				on: {
					submit: submitForm({
						status,
						abortSignal: signal,
						send: async (form, abortSignal) => {
							const value = formValue(form)
							if (!value.ok) return value
							const checked = checkAgainst(schema, value.value)
							return checked.ok ? send(checked.value, abortSignal) : checked
						},
						done,
					}),
				},
			}),
		)
	},
})
