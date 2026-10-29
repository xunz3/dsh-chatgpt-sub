/**
 * Outbound HTTP for the plugin.
 *
 * The Harness launcher installs one process-wide proxy policy on undici's
 * global dispatcher (`@deepseek-ai/dsh-http-proxy`), so the plugin must use the
 * global fetch rather than build its own dispatcher: an own dispatcher would
 * silently ignore the deployment's proxy, NO_PROXY, and loopback rules.
 *
 * Redirects stay an error for provider endpoints: an authorization server must
 * not be able to move a credentialed request somewhere else.
 */
export type Fetch = typeof globalThis.fetch

export const appFetch: Fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: 'error' })
