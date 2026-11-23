import { MissingSetting } from '@mesh-flow/gateway'
import { z } from 'zod'

const Returned = z.array(z.union([MissingSetting, z.string()]))

/**
 * What a connector's `missingSettings` returned, as missing settings. A connector is a package
 * the user installed, so it may be built against an older gateway, whose `missingSettings` gave
 * lines of text: each becomes a setting with only its message. Anything else is one setting that
 * says the connector answered with something the engine can't read.
 */
export function checkedMissingSettings(connector: string, returned: unknown): MissingSetting[] {
	const checked = Returned.safeParse(returned)
	if (!checked.success)
		return [{ message: `The ${connector} connector said what it's missing in a way the engine can't read.`, fix: { kind: 'other' } }]
	return checked.data.map((setting) => (typeof setting === 'string' ? { message: setting, fix: { kind: 'other' } } : setting))
}
