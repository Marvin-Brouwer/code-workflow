/**
 * The AWS connector, as workflow code uses it: `aws.checkSession`, as a function and as a tool.
 * Everything that needs AWS credentials runs on the host, through the gateway; the sandbox never
 * has them.
 *
 * @module
 */
export * as aws from '../aws.mts'
