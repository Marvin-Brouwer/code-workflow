/**
 * What the mesh-flow engine and the workflow runtime in a sandbox say to each other: the messages
 * and requests, the mailbox they pass through, and the runtime's side of it.
 *
 * @module
 */
export { defaultMailboxDirectory, MailboxLayout, mailboxEnvironmentVariable } from '../mailbox-layout.mts'
export { RequestId } from '../request-id.mts'
export { RuntimeMailbox } from '../runtime-mailbox.mts'
export { RuntimeEvent, RuntimeMessage, type Answer } from '../runtime-message.mts'
export { InputRequest, RuntimeRequest, WakeRequest } from '../runtime-request.mts'
