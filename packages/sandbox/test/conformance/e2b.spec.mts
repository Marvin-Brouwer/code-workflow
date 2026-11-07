import { e2bBackend } from '../../src/e2b/e2b.backend.mts'
import { describeConformance } from './conformance.mts'

// E2B_API_KEY, and MESH_FLOW_E2B_TEMPLATE for a template with Node 22 (and setsid).
describeConformance(
	'e2b',
	() =>
		e2bBackend({
			apiKey: process.env.E2B_API_KEY ?? '',
			templates: { 'node:22-slim': process.env.MESH_FLOW_E2B_TEMPLATE ?? 'base' },
		}),
	'node:22-slim',
)
