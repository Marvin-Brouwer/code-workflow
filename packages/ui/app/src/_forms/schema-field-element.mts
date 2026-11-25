import { choice } from '@rooted/components'
import type { ElementFactory } from '@rooted/components/elements'
import styles from './forms.css'
import { formNameOf, type SchemaField } from './schema-fields.mts'

/** Where a field is in the form. */
export interface FieldPlace {
	/** The form name of the object the field is in, for a nested field. */
	readonly objectFormName?: string | undefined
	/**
	 * Whether the field is in an object that may be left out: then nothing in it is required by the
	 * browser, since the object as a whole can stay empty. The schema still checks what's filled in.
	 */
	readonly inOptionalObject: boolean
}

/** A group of fields under a heading: an object's fields, or the options to tick of a field. */
function group(element: ElementFactory, label: string, hint: HTMLElement | undefined, children: readonly HTMLElement[]): HTMLElement {
	return element('fieldset', {
		children: [
			element('legend', {
				textContent: label,
			}),
			hint,
			...children,
		],
	})
}

/** What the form shows for `field` at `place`: a field to fill in, a group of them, or a fixed value. */
export function schemaFieldElement(element: ElementFactory, field: SchemaField, place: FieldPlace): HTMLElement {
	const formName = formNameOf(field, place.objectFormName)
	const required = field.required && !place.inOptionalObject
	const hint =
		field.description === undefined
			? undefined
			: element('span', {
					classes: styles.hint,
					textContent: field.description,
				})
	if (field.kind === 'object')
		return group(
			element,
			field.label,
			hint,
			field.fields.map((nested) =>
				schemaFieldElement(element, nested, {
					objectFormName: formName,
					inOptionalObject: place.inOptionalObject || !field.required,
				}),
			),
		)
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
		return group(
			element,
			field.label,
			hint,
			field.options.map((option) =>
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
		)
	const input =
		field.kind === 'choice'
			? element('select', {
					name: formName,
					required,
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
					required,
					type: choice(field.kind === 'text', 'text', 'number'),
					// An empty step is the default one, which an integer wants.
					step: choice(field.kind === 'number', 'any', ''),
				})
	return element('label', {
		children: [field.label, hint, input],
	})
}
