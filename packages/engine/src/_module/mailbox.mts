/**
 * The runtime's side of the mailbox between a sandbox and the engine, for the workflow runtime
 * inside the sandbox. Node built-ins only.
 *
 * @module
 */
export { mailboxEnvironmentVariable } from '../mailbox/mailbox-layout.mts'
export { RuntimeMailbox } from '../mailbox/runtime-mailbox.mts'
export type { Answer, RuntimeEvent, RuntimeMessage } from '../protocol/runtime-message.mts'
export type { InputRequest, RuntimeRequest, WakeRequest } from '../protocol/runtime-request.mts'
