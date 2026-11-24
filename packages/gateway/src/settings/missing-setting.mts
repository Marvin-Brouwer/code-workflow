import { z } from 'zod'

/**
 * What sets a missing setting, so a settings page knows which form to show:
 *
 * - `provider-key`: `provider` offers a model but has no API key;
 * - `credential`: set the credential `name`, which looks like `example` when there is one;
 * - `connector-for-tools`: no loaded connector brings these host tools;
 * - `connector`: the connector `connector` isn't loaded;
 * - `other`: the message is all there is, such as a model no provider in the app's config offers,
 *   which is a change to the config in git.
 */
export const SettingFix = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('provider-key'), provider: z.string() }),
	z.object({ kind: z.literal('credential'), name: z.string(), example: z.string().optional() }),
	z.object({ kind: z.literal('connector-for-tools'), tools: z.array(z.string()) }),
	z.object({ kind: z.literal('connector'), connector: z.string() }),
	z.object({ kind: z.literal('other') }),
])
export type SettingFix = z.infer<typeof SettingFix>

/** A setting an app needs that isn't there yet: a line that says what to do, and what sets it. */
export const MissingSetting = z.object({ message: z.string(), fix: SettingFix })
export type MissingSetting = z.infer<typeof MissingSetting>
