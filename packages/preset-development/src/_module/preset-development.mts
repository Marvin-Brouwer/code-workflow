/**
 * The development preset: what a workflow that takes a story from research to merged changes
 * needs besides its connectors. Shapes for research and the plan, the order a plan's repositories
 * are delivered in, a code review check for `verify` and the plan's deviations. Ships no agents:
 * the workflow passes its own.
 *
 * @module
 */
export { deviations, type Deviation, type Deviations, type Recorded } from '../deviations/deviations.mts'
export { deliveryOrder, type Delivery } from '../plan/delivery-order.mts'
export { Plan, planFile } from '../plan/plan.mts'
export { Research } from '../research/research.mts'
export { codeReview, type ReviewedCheckout } from '../review/code-review.mts'
