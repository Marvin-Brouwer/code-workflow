import { component } from '@rooted/components'
import type { Answer } from '../_shared/api.mts'
import styles from './forms.css'
import { formStatus, submitActions } from './form-parts.mts'
import { formText } from './form-text.mts'
import { schemaFieldElement } from './schema-field-element.mts'
import { checkAgainst, fieldsOf, jsonOf, valueOf } from './schema-fields.mts'
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
 * field per property, and a group of fields per object in it; anything else gets a JSON text area.
 * Either way the value is checked against the schema before it's sent, and the server checks it again.
 */
export const SchemaForm = component<SchemaFormOptions>({
	name: 'schema-form',
	styles,
	onMount({ append, element, options, signal }) {
		const { schema, submitLabel, send, done } = options
		const status = formStatus(element)
		const fields = fieldsOf(schema)

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
						: fields.map((field) =>
								schemaFieldElement(element, field, {
									inOptionalObject: false,
								}),
							)),
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
