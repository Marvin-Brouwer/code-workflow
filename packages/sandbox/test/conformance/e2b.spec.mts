import { e2bBackend } from '../../src/e2b/e2b.backend.mts'
import { describeConformance } from './conformance.mts'

const template = process.env.MESH_FLOW_E2B_TEMPLATE ?? 'base'

// E2B_API_KEY, and MESH_FLOW_E2B_TEMPLATE for a template with Node 22 (and setsid).
describeConformance(
	'e2b',
	() =>
		e2bBackend({
			apiKey: process.env.E2B_API_KEY ?? '',
			templates: { 'node:22-slim': template, 'node:22-bookworm': template },
		}),
	{ node: 'node:22-slim', packageManagers: 'node:22-bookworm' },
)
